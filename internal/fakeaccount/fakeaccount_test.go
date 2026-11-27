package fakeaccount

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// The fake serves pair-v1 only: browser requests (no kind, the plain list,
// an id it never made) and unknown refresh tokens are left for another
// handler, body intact.
func TestServeLeavesBrowserRoutesAndForeignSessions(t *testing.T) {
	s := New()
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/approvals", `{"commit":"x"}`},
		{http.MethodGet, "/v1/approvals", ""},
		{http.MethodGet, "/v1/approvals/req-1", ""},
		{http.MethodPost, "/v1/approvals/req-1/finish", `{"outcome":"denied"}`},
		{http.MethodPost, "/v1/auth/refresh", `{"refresh_token":"r1.foreign"}`},
	} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		if s.Serve(w, r) {
			t.Fatalf("%s %s served: %d %s", tc.method, tc.path, w.Code, w.Body)
		}
		rest, _ := io.ReadAll(r.Body)
		if string(rest) != tc.body {
			t.Fatalf("%s %s: body left %q", tc.method, tc.path, rest)
		}
	}
}

func TestHealthListsPairV1AndPairRoutesNeedASession(t *testing.T) {
	s := New()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/health", nil))
	var health struct{ Features []string }
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil || len(health.Features) != 1 || health.Features[0] != account.PairFeature {
		t.Fatalf("health %s, %v", w.Body, err)
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, account.PairSelfPath, nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("pairs/self without a session: %d", w.Code)
	}
}
