package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// deleteWorker is AccountService's web deletion (herdrup #783, DESIGN
// §6.6): start returns a single-use URL for the challenge; the browser comes
// back with a code; delete redeems it with the verifier, once.
type deleteWorker struct {
	mu sync.Mutex
	// onDelete runs inside POST /v1/account/delete before it answers; drop
	// closes the connection with no answer, after the deletion is done.
	onDelete  func()
	drop      bool
	webDelete bool
	challenge string
	provider  string
	deleted   bool
	n         int
}

const testDeleteCode = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"

func (w *deleteWorker) serve(rw http.ResponseWriter, r *http.Request) {
	w.mu.Lock()
	defer w.mu.Unlock()
	reply := func(status int, v any) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(status)
		_ = json.NewEncoder(rw).Encode(v)
	}
	var body map[string]string
	_ = json.NewDecoder(r.Body).Decode(&body)
	switch r.URL.Path {
	case "/v1/health":
		features := []string{"sync", "web_sign_in_apple"}
		if w.webDelete {
			features = append(features, "web_delete")
		}
		reply(200, map[string]any{"ok": true, "features": features})
	case "/v1/auth/handoff":
		w.n++
		reply(200, map[string]any{"account_id": "acct-2", "access_token": fmt.Sprintf("a1.%022d.%043d", 2, w.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", 2, w.n), "refresh_expires_in": 1})
	case "/v1/auth/refresh":
		if w.deleted && body["refresh_token"] < fmt.Sprintf("r1.%022d", 2) {
			reply(401, map[string]string{"error": "session_revoked"})
			return
		}
		w.n++
		reply(200, map[string]any{"account_id": "acct", "access_token": fmt.Sprintf("a1.%022d.%043d", 1, w.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, w.n), "refresh_expires_in": 1})
	case "/v1/account/delete/start":
		if len(body) != 2 || body["handoff_challenge"] == "" || (body["provider"] != "apple" && body["provider"] != "google") {
			reply(400, map[string]string{"error": "bad_request"})
			return
		}
		w.challenge, w.provider = body["handoff_challenge"], body["provider"]
		reply(200, map[string]any{"start_url": "https://accounts.example/v1/auth/web/delete?f=1", "expires_in": 300})
	case "/v1/account/delete":
		if len(body) != 2 || body["handoff_code"] != testDeleteCode {
			reply(401, map[string]string{"error": "invalid_code"})
			return
		}
		sum := sha256.Sum256([]byte(body["handoff_verifier"]))
		if base64.RawURLEncoding.EncodeToString(sum[:]) != w.challenge {
			reply(401, map[string]string{"error": "invalid_verifier"})
			return
		}
		w.deleted = true
		if hook := w.onDelete; hook != nil {
			w.mu.Unlock()
			hook()
			w.mu.Lock()
		}
		if w.drop {
			if hj, ok := rw.(http.Hijacker); ok {
				conn, _, _ := hj.Hijack()
				conn.Close()
				return
			}
		}
		reply(200, map[string]any{"deleted": true, "manual_revoke": w.provider == "apple"})
	default:
		reply(404, map[string]string{"error": "not_found"})
	}
}

func deleteDesk(t *testing.T) (*Desk, *deleteWorker, chan AccountDeleted, *[]string) {
	t.Helper()
	w := &deleteWorker{webDelete: true}
	srv := httptest.NewServer(http.HandlerFunc(w.serve))
	t.Cleanup(srv.Close)
	d := newDesk(t.TempDir())
	signInTo(d, srv, "acct")
	var opened []string
	d.openBrowser = func(u string) error { opened = append(opened, u); return nil }
	results := make(chan AccountDeleted, 4)
	previous, prevAccount := publishAccountDeleted, publishAccount
	publishAccountDeleted = func(r AccountDeleted) { results <- r }
	publishAccount = func(AccountState) {}
	t.Cleanup(func() { publishAccountDeleted, publishAccount = previous, prevAccount })
	return d, w, results, &opened
}

// The confirming sign-in opens in the browser; its code and the kept
// verifier delete the account, and this app is signed out after.
func TestDeletingTheAccountFromTheDesktop(t *testing.T) {
	d, w, results, opened := deleteDesk(t)
	ctx := context.Background()
	if info := d.AccountDeleteInfo(ctx); !info.Offered {
		t.Fatalf("web_delete listed, but not offered: %+v", info)
	}
	if err := d.AccountDelete(ctx, "apple"); err != nil {
		t.Fatal(err)
	}
	if len(*opened) != 1 || !strings.HasPrefix((*opened)[0], "https://accounts.example/") {
		t.Fatalf("opened %v", *opened)
	}
	if !d.queueAccountLink("herdrup://account#delete_code=" + testDeleteCode) {
		t.Fatal("a delete link was not taken")
	}
	r := <-results
	if !r.Deleted || !r.ManualRevoke || r.Problem != "" {
		t.Fatalf("result %+v", r)
	}
	if d.AccountState().SignedIn {
		t.Fatal("still signed in after the account was deleted")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.deleted {
		t.Fatal("the service never deleted the account")
	}
}

// A delete link nobody started here deletes nothing; a refusal from the
// browser leg says nothing was deleted; a service without web_delete isn't
// offered.
func TestADeletionNotStartedHereDeletesNothing(t *testing.T) {
	d, w, results, _ := deleteDesk(t)
	d.queueAccountLink("herdrup://account#delete_code=" + testDeleteCode)
	if r := <-results; r.Deleted || !strings.Contains(r.Problem, "Nothing was deleted") {
		t.Fatalf("an unstarted link: %+v", r)
	}
	if err := d.AccountDelete(context.Background(), "google"); err != nil {
		t.Fatal(err)
	}
	d.queueAccountLink("herdrup://account#delete_error=wrong_account")
	if r := <-results; r.Deleted || !strings.Contains(r.Problem, "different account") {
		t.Fatalf("wrong account: %+v", r)
	}
	// The verifier went with the refusal: the code can't be redeemed now.
	d.queueAccountLink("herdrup://account#delete_code=" + testDeleteCode)
	if r := <-results; r.Deleted {
		t.Fatalf("a code after its deletion was abandoned: %+v", r)
	}
	w.mu.Lock()
	w.webDelete = false
	deleted := w.deleted
	w.mu.Unlock()
	if deleted || !d.AccountState().SignedIn {
		t.Fatal("deleted or signed out without a confirmed deletion")
	}
	if d.AccountDeleteInfo(context.Background()).Offered {
		t.Fatal("offered without web_delete")
	}
}

// #272 review: a deletion whose answer arrives after this app signed in to
// another account deletes the old account but keeps the new session.
func TestALateDeletionKeepsTheNewSession(t *testing.T) {
	d, w, results, _ := deleteDesk(t)
	ctx := context.Background()
	if err := d.AccountDelete(ctx, "apple"); err != nil {
		t.Fatal(err)
	}
	client := d.account
	w.mu.Lock()
	w.onDelete = func() {
		// Signed out and back in (to another account) while the answer is on its way,
		// through the real sign-in: start, then redeem the browser's code.
		_ = client.SignOut(context.Background())
		if _, err := client.StartSignIn("google"); err != nil {
			t.Error(err)
			return
		}
		if _, err := client.FinishSignIn(context.Background(), testDeleteCode); err != nil {
			t.Error(err)
		}
	}
	w.mu.Unlock()
	d.queueAccountLink("herdrup://account#delete_code=" + testDeleteCode)
	r := <-results
	t.Logf("result %+v", r)
	if cur, _ := d.account.Current(); cur == nil || cur.AccountID != "acct-2" {
		t.Fatalf("the late deletion dropped the new session: %+v", cur)
	}
}

// #272 review: the service deletes before it answers, so a lost answer is
// "not confirmed", never "nothing was deleted".
func TestALostDeletionAnswerIsNotReportedAsNoDeletion(t *testing.T) {
	d, w, results, _ := deleteDesk(t)
	if err := d.AccountDelete(context.Background(), "google"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	w.drop = true
	w.mu.Unlock()
	d.queueAccountLink("herdrup://account#delete_code=" + testDeleteCode)
	r := <-results
	if r.Deleted || strings.Contains(r.Problem, "Nothing was deleted") || !strings.Contains(r.Problem, "isn't confirmed") {
		t.Fatalf("a lost answer: %+v", r)
	}
}
