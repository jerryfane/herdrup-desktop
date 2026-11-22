package main

import (
	"context"
	"errors"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// Deleting the HerdrUp account from the desktop (DESIGN #698 §6.6, herdrup
// #783): a fresh sign-in in the system browser confirms it, as the Swift
// app's re-authentication does. Offered once /v1/health lists web_delete.

// AccountDeleteInfo is what the account page needs to offer Delete account.
type AccountDeleteInfo struct {
	// Offered is true once the service can confirm a deletion in the browser.
	Offered bool `json:"offered"`
	// Provider is how this session signed in ("apple", "google"), "" when the
	// session predates it being kept: the page asks then.
	Provider string `json:"provider"`
}

// AccountDeleted tells the page how a deletion ended: Deleted with
// ManualRevoke (Apple didn't confirm the revoke), or Problem.
type AccountDeleted struct {
	Deleted      bool   `json:"deleted"`
	ManualRevoke bool   `json:"manualRevoke,omitempty"`
	Problem      string `json:"problem,omitempty"`
}

// AccountDeletedEvent carries the end of a deletion the browser finished.
var AccountDeletedEvent = mygo.NewEvent[AccountDeleted]("account:deleted")

// publishAccountDeleted sends one deletion result to the page; tests replace it.
var publishAccountDeleted = func(r AccountDeleted) { AccountDeletedEvent.Broadcast(r) }

// AccountDeleteInfo asks the service whether it offers web deletion.
func (d *Desk) AccountDeleteInfo(ctx context.Context) AccountDeleteInfo {
	cur, _ := d.account.Current()
	if cur == nil {
		return AccountDeleteInfo{}
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	offered, _ := d.account.WebDeleteOffered(ctx)
	return AccountDeleteInfo{Offered: offered, Provider: string(cur.Provider)}
}

// AccountDelete starts the deletion: the confirming sign-in with provider
// ("apple" or "google") opens in the system browser, which comes back on
// herdrup://account#delete_code=… (queueAccountLink).
func (d *Desk) AccountDelete(ctx context.Context, provider string) error {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	link, err := d.account.StartDelete(ctx, cur.AccountID, account.Provider(provider))
	if err != nil {
		return err
	}
	return d.openBrowser(link)
}

// finishAccountDelete redeems a deletion's return link and tells the page.
func (d *Desk) finishAccountDelete(link string) {
	if failed, isError := account.DeleteErrorFromLink(link); isError {
		d.account.AbandonDelete()
		publishAccountDeleted(AccountDeleted{Problem: deleteEndedProblem(failed)})
		return
	}
	code, ok := account.DeleteCodeFromLink(link)
	cur, _ := d.account.Current()
	if !ok || cur == nil {
		publishAccountDeleted(AccountDeleted{Problem: "This link doesn't finish a deletion. Nothing was deleted."})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := d.account.FinishDelete(ctx, cur.AccountID, code)
	if err != nil {
		publishAccountDeleted(AccountDeleted{Problem: deleteProblem(err)})
		return
	}
	// The account and its sessions are gone; machines and prompts stay here.
	d.noteSync(cur.AccountID, false)
	publishAccount(d.accountState(""))
	publishAccountDeleted(AccountDeleted{Deleted: true, ManualRevoke: out.ManualRevoke})
}

// deleteEndedProblem is a deletion's browser leg that ended without a code,
// in the app's words; "" for a cancel.
func deleteEndedProblem(code string) string {
	switch code {
	case "cancelled":
		return ""
	case "wrong_account":
		return "You signed in with a different account. Nothing was deleted."
	case "flow_expired":
		return "The confirmation took too long. Nothing was deleted. Try again."
	case "browser_mismatch":
		return "The confirmation finished in a different browser than it started in. Nothing was deleted."
	case "provider_not_configured":
		return "Deleting this way isn't available yet."
	}
	return "The confirmation didn't go through. Nothing was deleted. Try again."
}

func deleteProblem(err error) string {
	var api *account.APIError
	switch {
	case errors.Is(err, account.ErrDeleteUnconfirmed):
		// The service deletes before it answers: a lost answer may hide a deletion.
		return "The account service didn't answer, so the deletion isn't confirmed. Open this page again to see whether the account still exists."
	case errors.Is(err, account.ErrNoDelete):
		return "This confirmation was started elsewhere or already used. Nothing was deleted."
	case errors.As(err, &api) && api.Code == "wrong_account":
		return "You signed in with a different account. Nothing was deleted."
	case errors.As(err, &api) && api.Status < 500:
		return "The confirmation didn't go through. Nothing was deleted. Try again."
	case errors.As(err, &api):
		return "The account service is unavailable. Nothing was deleted. Try again later."
	}
	return "Couldn't reach the account service. Nothing was deleted."
}
