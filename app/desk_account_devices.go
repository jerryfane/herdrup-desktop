package main

import (
	"context"
	"errors"
	"log"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// The account's devices (DESIGN #698 §3; Swift HerdrUpAccount.enrolThisDevice,
// refreshDevices, renameDevice, removeDevice): this install's guest key is
// added to the account after sign-in, and the account page lists, renames and
// removes devices.

// AccountDevice is one device as the account page lists it.
type AccountDevice struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	CreatedMs int64  `json:"createdMs"`
	// Current is this computer.
	Current bool `json:"current"`
}

// AccountDevices is the page's DEVICES group: the list (this computer
// first, then oldest first) and, when this computer isn't in it, why.
type AccountDevices struct {
	Devices []AccountDevice `json:"devices"`
	// Enrolment is "" when this computer is a device of the account, else the
	// service's refusal code (too_many_devices, device_in_other_account) or
	// "unreachable".
	Enrolment string `json:"enrolment,omitempty"`
}

// accountEnrol remembers, per account, the newest enrolment refusal, so the
// page can say why this computer isn't listed; a success clears it.
type accountEnrol struct {
	mu     sync.Mutex
	failed map[string]string
}

func (d *Desk) noteEnrolment(acct, code string) {
	d.accountEnrol.mu.Lock()
	defer d.accountEnrol.mu.Unlock()
	if code == "" {
		delete(d.accountEnrol.failed, acct)
		return
	}
	if d.accountEnrol.failed == nil {
		d.accountEnrol.failed = map[string]string{}
	}
	d.accountEnrol.failed[acct] = code
}

func (d *Desk) enrolmentProblem(acct string) string {
	d.accountEnrol.mu.Lock()
	defer d.accountEnrol.mu.Unlock()
	return d.accountEnrol.failed[acct]
}

// accountDeviceName is this computer's name as the account lists it.
func accountDeviceName() string {
	// "jerrys-mbp.local" reads as "jerrys-mbp".
	if name := account.DeviceName(strings.TrimSuffix(hostDisplayName(), ".local")); name != "" {
		return name
	}
	return "This computer"
}

// hostDisplayName is the computer's name; tests replace it.
var hostDisplayName = func() string {
	name, _ := os.Hostname()
	return name
}

// enrolThisDevice adds this install's guest key to the signed-in account
// (idempotent: a key already there binds this session to it). It records a
// refusal for the page and returns it.
func (d *Desk) enrolThisDevice(ctx context.Context) error {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return err
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return err
	}
	_, err = d.account.Enrol(ctx, cur.AccountID, identity, accountDeviceName(), accountPlatform(runtime.GOOS))
	var api *account.APIError
	switch {
	case err == nil:
		d.noteEnrolment(cur.AccountID, "")
	case errors.Is(err, account.ErrSignedOut), errors.Is(err, account.ErrAccountChanged):
		return err
	case errors.As(err, &api) && api.Code != "":
		d.noteEnrolment(cur.AccountID, api.Code)
	default:
		d.noteEnrolment(cur.AccountID, "unreachable")
	}
	return err
}

// AccountDevices lists the account's devices. When this computer isn't
// among them (first sign-in raced, or an older version signed in) it is
// added first, as the Swift app does.
func (d *Desk) AccountDevices(ctx context.Context) (AccountDevices, error) {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return AccountDevices{Devices: []AccountDevice{}}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	list, err := d.account.Devices(ctx, cur.AccountID)
	if err != nil {
		return AccountDevices{Devices: []AccountDevice{}}, err
	}
	if !slices.ContainsFunc(list, func(dv account.Device) bool { return dv.Current }) && d.enrolmentProblem(cur.AccountID) == "" {
		if d.enrolThisDevice(ctx) == nil {
			if again, err := d.account.Devices(ctx, cur.AccountID); err == nil {
				list = again
			}
		}
	}
	out := AccountDevices{Devices: make([]AccountDevice, 0, len(list)), Enrolment: d.enrolmentProblem(cur.AccountID)}
	for _, dv := range list {
		out.Devices = append(out.Devices, AccountDevice{ID: dv.ID, Name: dv.Name, Platform: dv.Platform, CreatedMs: dv.CreatedMs, Current: dv.Current})
	}
	slices.SortStableFunc(out.Devices, func(a, b AccountDevice) int {
		if a.Current != b.Current {
			if a.Current {
				return -1
			}
			return 1
		}
		return int(a.CreatedMs - b.CreatedMs)
	})
	if slices.ContainsFunc(out.Devices, func(dv AccountDevice) bool { return dv.Current }) {
		out.Enrolment = ""
	}
	return out, nil
}

// AccountEnrolAgain retries adding this computer (the page's "Try again").
func (d *Desk) AccountEnrolAgain(ctx context.Context) (AccountDevices, error) {
	if cur, _ := d.account.Current(); cur != nil {
		d.noteEnrolment(cur.AccountID, "")
	}
	return d.AccountDevices(ctx)
}

// AccountRenameDevice renames device id.
func (d *Desk) AccountRenameDevice(ctx context.Context, id, name string) error {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	_, err = d.account.RenameDevice(ctx, cur.AccountID, id, name)
	return err
}

// AccountRemoveDevice removes device id. Removing this computer ends its
// session too (the service drops the sessions bound to the device), so it
// is signed out here as well.
func (d *Desk) AccountRemoveDevice(ctx context.Context, id string, current bool) error {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := d.account.RemoveDevice(ctx, cur.AccountID, id); err != nil {
		return err
	}
	if current {
		if err := d.account.SignOut(ctx); err != nil {
			log.Printf("account: sign-out after removing this device: %v", err)
		}
		publishAccount(d.accountState(""))
	}
	return nil
}

func errSignedOutHere(err error) error {
	if err != nil {
		return err
	}
	return account.ErrSignedOut
}
