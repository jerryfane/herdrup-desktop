package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// guestsTransport answers calls from the fake herdr's guest stores and counts
// the guest.update calls that reached it.
type guestsTransport struct {
	guests  *fakeherdr.Guests
	updates int
}

func (t *guestsTransport) Call(_ context.Context, method string, params, result any) error {
	if method == "guest.update" {
		t.updates++
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	answer, apiErr, ok := t.guests.Handle(method, raw)
	if !ok {
		return errors.New("the fixture doesn't answer " + method)
	}
	if apiErr != nil {
		return &bridge.APIError{Code: apiErr.Code, Message: apiErr.Message}
	}
	data, err := json.Marshal(answer)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, result)
}

func (t *guestsTransport) OpenStream(context.Context, string, any) (engine.Stream, error) {
	return nil, errors.New("no streams")
}

func (t *guestsTransport) Done() <-chan struct{} { return nil }

// sharing is whether guest id on this machine has Gram sharing on.
func (t *guestsTransport) sharing(tb testing.TB, id string) bool {
	tb.Helper()
	answer, apiErr, _ := t.guests.Handle("guest.list", json.RawMessage(`{}`))
	if apiErr != nil {
		tb.Fatal(apiErr.Message)
	}
	var list struct {
		Guests []struct {
			GuestID   string `json:"guest_id"`
			ShareGram bool   `json:"share_gram"`
		} `json:"guests"`
	}
	data, _ := json.Marshal(answer)
	if err := json.Unmarshal(data, &list); err != nil {
		tb.Fatal(err)
	}
	for _, g := range list.Guests {
		if g.GuestID == id {
			return g.ShareGram
		}
	}
	tb.Fatalf("no guest %s", id)
	return false
}

// #567: GuestShareGram's bool took a missing or null share_gram as false, so
// `guest.update {"guest_id": …}` stopped sharing where herdr refuses it. The
// CLI refuses it as herdr does (invalid_params) before anything is sent, and
// passes an explicit false or true on.
// Nike's first share (nike-1) starts shared, Alex's (guest-1) doesn't.
func TestGuestUpdateNeedsAnExplicitShareGram(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name, params, guest string
		refused             bool
		sharing             bool
	}{
		{"missing", `{"guest_id": "nike-1"}`, "nike-1", true, true},
		{"null", `{"guest_id": "nike-1", "share_gram": null}`, "nike-1", true, true},
		{"no guest", `{"share_gram": false}`, "nike-1", true, true},
		{"no params", ``, "nike-1", true, true},
		{"false", `{"guest_id": "nike-1", "share_gram": false}`, "nike-1", false, false},
		{"true", `{"guest_id": "guest-1", "share_gram": true}`, "guest-1", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := &guestsTransport{guests: fakeherdr.NewGuests()}
			_, err := calls["guest.update"](ctx, engine.New(tr), []byte(tc.params))
			var api *bridge.APIError
			if tc.refused {
				if !errors.As(err, &api) || api.Code != "invalid_params" {
					t.Fatalf("guest.update %s = %v, want invalid_params", tc.params, err)
				}
				if tr.updates != 0 {
					t.Fatalf("guest.update %s reached herdr", tc.params)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if got := tr.sharing(t, tc.guest); got != tc.sharing {
				t.Fatalf("after guest.update %s, %s's Gram sharing = %v, want %v", tc.params, tc.guest, got, tc.sharing)
			}
		})
	}
}
