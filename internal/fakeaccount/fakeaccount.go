// Package fakeaccount is the account service's pair-v1 (pair from another
// device) in memory, for tests: sessions for the devices a test adds,
// /v1/health, and the pair request routes as AccountService runs them
// (DESIGN §13, src/approvals.ts on themartianapp/herdrup#870). The wire is
// internal/account's (pairs.go); the commit check at the reveal is written
// out here on its own, so a client whose commit differs from the
// contract's is refused as the real service would refuse it.
//
// Every device is in one account. A request lives 10 minutes; the first
// read past them stores its expiry, which is then final; a new request
// replaces the new device's earlier one, envelope included, and the new
// device may cancel it while it is open, after which every step answers
// 410. The finish stores the envelope on the request and keeps the request
// for 10 more minutes, during which its claimant may replace the envelope
// with a higher seq. Browser requests aren't served: their routes fall
// through, and GET /v1/approvals?kind=any lists only the pair requests.
package fakeaccount

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

const (
	// RequestTTL is how long a pair request waits for its approval.
	RequestTTL = 10 * time.Minute
	// OutcomeKeep is how long a finished request stays readable, and its
	// claimant may replace the envelope.
	OutcomeKeep = 10 * time.Minute
	// MaxSealedLength is the longest sealed envelope taken.
	MaxSealedLength = account.MaxSealedLength
	minSealedBytes  = 12 + 16
	commitLabel     = "herdrup-pair-v1|commit"
)

// Device is one device of the account. Pub is its X25519 key, unpadded
// base64url; Platform "web" makes it a browser, which can neither ask nor
// approve.
type Device struct {
	ID, Pub, Name, Platform string
	CreatedMs               int64
}

// Request is a pair request as the service holds it: keys, nonces and the
// sealed envelope unpadded base64url, Approver the claimant's device id,
// Outcome "" while it is live, Seq 0 before the finish.
type Request struct {
	ID, Requester, Commit, SSHPub string
	Approver, NonceT, NonceB      string
	Outcome                       string
	Seq                           uint64
	Sealed                        string
	// Expires is the end of the 10 minutes, or of the 10 minutes kept
	// after the finish.
	Expires time.Time
}

// Service is the fake. Set its fields before serving.
type Service struct {
	// Now is the service's clock; nil is the wall clock.
	Now func() time.Time
	// Features are what /v1/health lists; New lists pair_v1.
	Features []string
	// Account is the account id sessions carry.
	Account string
	// Intercept, when set, sees each request first and answers it by
	// returning true (a fault, a lost answer).
	Intercept func(w http.ResponseWriter, r *http.Request) bool

	mu       sync.Mutex
	n        int
	devices  map[string]Device
	access   map[string]string // access token → device id
	refresh  map[string]string // refresh token → device id
	requests []*Request
}

// New is a service for account acct-1 that offers pair_v1.
func New() *Service {
	return &Service{Features: []string{account.PairFeature}, Account: "acct-1",
		devices: map[string]Device{}, access: map[string]string{}, refresh: map[string]string{}}
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// AddDevice enrols d and returns a refresh token for a session bound to it:
// a client whose store holds it signs in as d.
func (s *Service) AddDevice(d Device) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.devices[d.ID] = d
	t := s.token("r1")
	s.refresh[t] = d.ID
	return t
}

// token is a fresh token of the service's shape (prefix.22.43).
func (s *Service) token(prefix string) string {
	s.n++
	return fmt.Sprintf("%s.%022d.%043d", prefix, 4, s.n)
}

// Requests are the service's pair requests, in the order they were made.
func (s *Service) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Request, len(s.requests))
	for i, r := range s.requests {
		out[i] = *r
	}
	return out
}

// ServeHTTP answers Serve's routes and 404 not_found for any other.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.Serve(w, r) {
		reply(w, http.StatusNotFound, map[string]string{"error": "not_found"})
	}
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func refuse(w http.ResponseWriter, status int, code string) {
	reply(w, status, map[string]string{"error": code})
}

// bytes32 is s when it is canonical unpadded base64url of 32 bytes.
func bytes32(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return b, err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == s
}

// Serve answers the request when it is one of the fake's and reports
// whether it did: the refresh of a session it issued, /v1/health, and the
// pair-v1 routes. Anything else (a browser request, another session's
// refresh) is left, body intact, for another handler.
func (s *Service) Serve(w http.ResponseWriter, r *http.Request) bool {
	if s.Intercept != nil && s.Intercept(w, r) {
		return true
	}
	raw, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	str := func(k string) string { v, _ := body[k].(string); return v }

	s.mu.Lock()
	defer s.mu.Unlock()
	path, method := r.URL.Path, r.Method
	switch {
	case path == "/v1/health" && method == http.MethodGet:
		reply(w, 200, map[string]any{"ok": true, "version": "fake", "features": s.Features})
		return true
	case path == "/v1/auth/refresh" && method == http.MethodPost:
		id, ok := s.refresh[str("refresh_token")]
		if !ok {
			return false
		}
		delete(s.refresh, str("refresh_token"))
		access, next := s.token("a1"), s.token("r1")
		s.access[access], s.refresh[next] = id, id
		reply(w, 200, map[string]any{"account_id": s.Account, "access_token": access, "access_expires_in": 3600,
			"refresh_token": next, "refresh_expires_in": 7776000})
		return true
	}

	var handle func(caller Device)
	id, step, isApproval := approvalPath(path)
	switch {
	case path == "/v1/approvals" && method == http.MethodPost:
		if str("kind") != account.PairKind {
			return false
		}
		handle = func(c Device) { s.create(w, c, str("commit"), str("ssh_pub")) }
	case path == "/v1/approvals" && method == http.MethodGet:
		if kind := r.URL.Query().Get("kind"); kind != account.PairKind && kind != "any" {
			return false
		}
		handle = func(c Device) { s.list(w, c) }
	case path == account.PairSelfPath && method == http.MethodGet:
		handle = func(c Device) { s.self(w, c) }
	case !isApproval || s.find(id) == nil:
		// Not a pair request: a browser's, or one replaced or never made.
		return false
	case step == "" && method == http.MethodGet:
		handle = func(c Device) { s.read(w, c, id) }
	case step == "claim" && method == http.MethodPost:
		handle = func(c Device) { s.claim(w, c, id, str("nonce_t")) }
	case step == "reveal" && method == http.MethodPost:
		handle = func(c Device) { s.reveal(w, c, id, str("nonce_b")) }
	case step == "cancel" && method == http.MethodPost:
		handle = func(c Device) { s.cancel(w, c, id) }
	case step == "finish" && method == http.MethodPost:
		handle = func(c Device) { s.finish(w, c, id, body) }
	case step == "envelope" && method == http.MethodPut:
		handle = func(c Device) { s.putEnvelope(w, c, id, body) }
	default:
		return false
	}
	caller, ok := s.devices[s.access[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]]
	if !ok {
		refuse(w, http.StatusUnauthorized, "unauthorized")
		return true
	}
	s.storeExpiry()
	handle(caller)
	return true
}

// approvalPath splits /v1/approvals/<id>[/<step>].
func approvalPath(path string) (id, step string, ok bool) {
	rest, found := strings.CutPrefix(path, "/v1/approvals/")
	if !found || rest == "" {
		return "", "", false
	}
	id, step, _ = strings.Cut(rest, "/")
	return id, step, !strings.Contains(step, "/")
}

func (s *Service) find(id string) *Request {
	for _, r := range s.requests {
		if r.ID == id {
			return r
		}
	}
	return nil
}

// storeExpiry stores the expiry of every live request past its time, as
// each read and step does first, so a reported expiry is final.
func (s *Service) storeExpiry() {
	now := s.now()
	for _, r := range s.requests {
		if r.Outcome == "" && !now.Before(r.Expires) {
			r.Outcome = account.ApprovalExpired
		}
	}
}

func (s *Service) state(r *Request) string {
	switch {
	case r.Outcome != "":
		return r.Outcome
	case r.NonceB != "":
		return account.ApprovalRevealed
	case r.Approver != "":
		return account.ApprovalClaimed
	}
	return account.ApprovalWaiting
}

// notLive refuses a step on a request that ended, as notLive does.
func notLive(w http.ResponseWriter, r *Request) bool {
	switch r.Outcome {
	case "":
		return false
	case account.ApprovalExpired:
		refuse(w, http.StatusGone, "expired")
	case account.ApprovalCancelled:
		refuse(w, http.StatusGone, "cancelled")
	default:
		refuse(w, http.StatusConflict, "already_finished")
	}
	return true
}

func (s *Service) expiresIn(r *Request) int64 {
	left := r.Expires.Sub(s.now())
	if left <= 0 {
		return 0
	}
	return int64((left + time.Second - 1) / time.Second)
}

func (s *Service) requester(r *Request) account.RequestDevice {
	d := s.devices[r.Requester]
	return account.RequestDevice{DeviceID: d.ID, DevicePub: d.Pub, Name: d.Name, Platform: d.Platform, CreatedMs: d.CreatedMs}
}

func (s *Service) create(w http.ResponseWriter, c Device, commit, sshPub string) {
	if c.Platform == "web" {
		refuse(w, http.StatusForbidden, account.PairErrNotNative)
		return
	}
	_, ok1 := bytes32(commit)
	_, ok2 := bytes32(sshPub)
	if !ok1 || !ok2 {
		refuse(w, http.StatusBadRequest, "bad_request")
		return
	}
	// One request per new device: a new one replaces it, whatever its state.
	s.requests = slices.DeleteFunc(s.requests, func(r *Request) bool { return r.Requester == c.ID })
	s.n++
	r := &Request{ID: fmt.Sprintf("pair%018d", s.n), Requester: c.ID, Commit: commit, SSHPub: sshPub, Expires: s.now().Add(RequestTTL)}
	s.requests = append(s.requests, r)
	reply(w, http.StatusCreated, account.PairCreated{ID: r.ID, ExpiresIn: int64(RequestTTL / time.Second)})
}

func (s *Service) list(w http.ResponseWriter, c Device) {
	if c.Platform == "web" {
		refuse(w, http.StatusForbidden, "not_an_approver")
		return
	}
	out := []account.PairRequest{}
	for _, r := range s.requests {
		if r.Outcome != "" || r.Requester == c.ID {
			continue
		}
		claimed := "no"
		switch r.Approver {
		case "":
		case c.ID:
			claimed = "you"
		default:
			claimed = "other"
		}
		out = append(out, account.PairRequest{ID: r.ID, Kind: account.PairKind, Requester: s.requester(r), Commit: r.Commit,
			SSHPub: r.SSHPub, Claimed: claimed, ExpiresIn: s.expiresIn(r)})
	}
	reply(w, 200, map[string]any{"requests": out})
}

// cancel is the new device ending its open request.
func (s *Service) cancel(w http.ResponseWriter, c Device, id string) {
	r := s.find(id)
	switch {
	case c.Platform == "web":
		refuse(w, http.StatusForbidden, account.PairErrNotNative)
	case r.Requester != c.ID:
		refuse(w, http.StatusNotFound, "not_found")
	case notLive(w, r):
	default:
		r.Outcome, r.Expires = account.ApprovalCancelled, s.now().Add(OutcomeKeep)
		reply(w, 200, map[string]string{"state": account.ApprovalCancelled})
	}
}

func (s *Service) read(w http.ResponseWriter, c Device, id string) {
	r := s.find(id)
	if c.Platform == "web" {
		refuse(w, http.StatusNotFound, "not_found")
		return
	}
	state := s.state(r)
	live := state == account.ApprovalClaimed || state == account.ApprovalRevealed
	claimant := r.Approver == c.ID
	device := s.requester(r)
	out := account.ApprovalStatus{State: state, ExpiresIn: s.expiresIn(r), OutcomeStored: r.Outcome != "",
		Kind: account.PairKind, Commit: r.Commit, SSHPub: r.SSHPub, Device: &device}
	if a, ok := s.devices[r.Approver]; ok {
		out.Approver = &struct {
			DevicePub string `json:"device_pub"`
			Name      string `json:"name"`
		}{a.Pub, a.Name}
	}
	if live && (r.Requester == c.ID || claimant) {
		out.NonceT = r.NonceT
	}
	if live && claimant {
		out.NonceB = r.NonceB
	}
	reply(w, 200, out)
}

func (s *Service) claim(w http.ResponseWriter, c Device, id, nonceT string) {
	if c.Platform == "web" {
		refuse(w, http.StatusForbidden, "not_an_approver")
		return
	}
	if _, ok := bytes32(nonceT); !ok {
		refuse(w, http.StatusBadRequest, "bad_request")
		return
	}
	r := s.find(id)
	switch {
	case r.Requester == c.ID:
		refuse(w, http.StatusForbidden, account.PairErrOwnRequest)
	case notLive(w, r):
	case r.Approver != "":
		refuse(w, http.StatusConflict, "already_claimed")
	default:
		r.Approver, r.NonceT = c.ID, nonceT
		reply(w, 200, map[string]string{"state": account.ApprovalClaimed})
	}
}

func (s *Service) reveal(w http.ResponseWriter, c Device, id, nonceB64 string) {
	nonceB, ok := bytes32(nonceB64)
	if !ok {
		refuse(w, http.StatusBadRequest, "bad_request")
		return
	}
	r := s.find(id)
	switch {
	case r.Requester != c.ID:
		refuse(w, http.StatusNotFound, "not_found")
	case notLive(w, r):
	case r.Approver == "":
		refuse(w, http.StatusConflict, "not_claimed")
	case r.NonceB != "":
		refuse(w, http.StatusConflict, "already_revealed")
	case !opens(c.Pub, r.SSHPub, r.Commit, nonceB):
		// A reveal that doesn't open the commit ends the request.
		r.Outcome, r.Expires = account.ApprovalDenied, s.now().Add(OutcomeKeep)
		refuse(w, http.StatusBadRequest, "reveal_mismatch")
	default:
		r.NonceB = nonceB64
		reply(w, 200, map[string]string{"state": account.ApprovalRevealed})
	}
}

// opens is the service's own commit check: SHA-256(label ‖ 0x00 ‖ B ‖ S ‖
// nonce_b) against the stored commit.
func opens(requesterPub, sshPub, commit string, nonceB []byte) bool {
	b, ok1 := bytes32(requesterPub)
	sk, ok2 := bytes32(sshPub)
	if !ok1 || !ok2 {
		return false
	}
	h := sha256.New()
	h.Write([]byte(commitLabel))
	h.Write([]byte{0})
	h.Write(b)
	h.Write(sk)
	h.Write(nonceB)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)) == commit
}

// sealed reads {seq, sealed} as readSealed does: seq a safe integer ≥ 1,
// sealed canonical unpadded base64url of at least an IV and a tag, at most
// MaxSealedLength long.
func sealed(body map[string]any) (uint64, string, bool) {
	seq, ok := body["seq"].(float64)
	text, _ := body["sealed"].(string)
	if !ok || seq < 1 || seq > account.MaxPairSeq || seq != float64(uint64(seq)) || len(text) > MaxSealedLength {
		return 0, "", false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(text)
	if err != nil || len(raw) < minSealedBytes || base64.RawURLEncoding.EncodeToString(raw) != text {
		return 0, "", false
	}
	return uint64(seq), text, true
}

func (s *Service) finish(w http.ResponseWriter, c Device, id string, body map[string]any) {
	if c.Platform == "web" {
		refuse(w, http.StatusForbidden, "not_an_approver")
		return
	}
	outcome, _ := body["outcome"].(string)
	seq, text, ok := sealed(body)
	if outcome != account.ApprovalDenied && (outcome != account.ApprovalApproved || !ok) {
		refuse(w, http.StatusBadRequest, "bad_request")
		return
	}
	r := s.find(id)
	switch {
	case r.Approver != c.ID:
		// Only the claimant finishes; to anyone else the request doesn't exist.
		refuse(w, http.StatusNotFound, "not_found")
	case notLive(w, r):
	case outcome == account.ApprovalDenied:
		r.Outcome, r.Expires = account.ApprovalDenied, s.now().Add(OutcomeKeep)
		reply(w, 200, map[string]string{"state": account.ApprovalDenied})
	case r.NonceB == "":
		refuse(w, http.StatusConflict, "not_revealed")
	default:
		r.Outcome, r.Expires, r.Seq, r.Sealed = account.ApprovalApproved, s.now().Add(OutcomeKeep), seq, text
		reply(w, 200, map[string]string{"state": account.ApprovalApproved})
	}
}

func (s *Service) putEnvelope(w http.ResponseWriter, c Device, id string, body map[string]any) {
	if c.Platform == "web" {
		refuse(w, http.StatusForbidden, "not_an_approver")
		return
	}
	seq, text, ok := sealed(body)
	if !ok {
		refuse(w, http.StatusBadRequest, "bad_request")
		return
	}
	r := s.find(id)
	switch {
	case r.Approver != c.ID:
		refuse(w, http.StatusNotFound, "not_found")
	case r.Outcome == account.ApprovalExpired || r.Outcome == account.ApprovalCancelled || !s.now().Before(r.Expires):
		refuse(w, http.StatusGone, "expired")
	case r.Outcome != account.ApprovalApproved:
		refuse(w, http.StatusConflict, account.PairErrNotApproved)
	case seq <= r.Seq:
		refuse(w, http.StatusConflict, account.PairErrStaleSeq)
	default:
		r.Seq, r.Sealed = seq, text
		reply(w, 200, map[string]uint64{"seq": seq})
	}
}

func (s *Service) self(w http.ResponseWriter, c Device) {
	if c.Platform == "web" {
		refuse(w, http.StatusForbidden, account.PairErrNotNative)
		return
	}
	i := slices.IndexFunc(s.requests, func(r *Request) bool { return r.Requester == c.ID })
	if i < 0 {
		reply(w, 200, map[string]any{"envelopes": []any{}})
		return
	}
	r := s.requests[i]
	request := map[string]any{"id": r.ID, "state": s.state(r), "expires_in": s.expiresIn(r)}
	if r.Outcome != "" {
		request["outcome_stored"] = true
	}
	envelopes := []account.PairSealed{}
	if a, ok := s.devices[r.Approver]; ok && r.Sealed != "" {
		envelopes = append(envelopes, account.PairSealed{RequestID: r.ID, SSHPub: r.SSHPub, ApproverPub: a.Pub, ApproverName: a.Name, Seq: r.Seq, Sealed: r.Sealed})
	}
	reply(w, 200, map[string]any{"request": request, "envelopes": envelopes})
}
