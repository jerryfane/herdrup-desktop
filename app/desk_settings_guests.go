package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func guestMachineAlias(alias string) *string {
	if alias == "" {
		return nil
	}
	return &alias
}

// SettingsGuestMachine keeps listing and audit failures distinct: an unreadable
// activity log is not evidence that a guest has done nothing.
func (d *Desk) SettingsGuestMachine(ctx context.Context, token, machine string) (string, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	var result struct {
		Listing        *herdrapi.ResponseResultGuestList `json:"listing,omitempty"`
		Entries        []herdrapi.GuestAuditEntry        `json:"entries"`
		Error          string                            `json:"error,omitempty"`
		AuditError     string                            `json:"auditError,omitempty"`
		MissingFeature bool                              `json:"missingFeature,omitempty"`
	}
	listing, err := view.client.GuestList(ctx, herdrapi.GuestListParams{Machine: guestMachineAlias(machine)})
	if err != nil {
		result.Error = err.Error()
		var unsupported *engine.ErrUnsupported
		var api *bridge.APIError
		result.MissingFeature = errors.As(err, &unsupported) || (errors.As(err, &api) && (api.Code == "unsupported" || api.Code == "invalid_request" && strings.Contains(api.Message, "unknown variant")))
	} else {
		result.Listing = &listing
		limit := uint64(100)
		audit, err := view.client.GuestAudit(ctx, herdrapi.GuestAuditParams{Machine: guestMachineAlias(machine), Limit: &limit})
		if err != nil {
			result.AuditError = err.Error()
		} else {
			result.Entries = audit.Entries
		}
	}
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	data, err := json.Marshal(result)
	return string(data), err
}

func (d *Desk) SetGuestGramSharing(ctx context.Context, token, machine, guestID string, share bool) error {
	view, err := d.settingsView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	_, err = view.client.GuestUpdate(ctx, herdrapi.GuestUpdateParams{Machine: guestMachineAlias(machine), GuestID: guestID, ShareGram: share})
	return err
}

func (d *Desk) RevokeGuestAccess(ctx context.Context, token, machine, id string, invite bool) error {
	view, err := d.settingsView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	params := herdrapi.GuestRevokeParams{Machine: guestMachineAlias(machine)}
	if invite {
		params.InviteID = &id
	} else {
		params.GuestID = &id
	}
	_, err = view.client.GuestRevoke(ctx, params)
	return err
}

// RevokeGuestPerson revokes every share of one person on machine at once
// (guest.revoke {person}): a person from guest.list, the HerdrUp account
// behind an account-bound share, else a plain share's device fingerprint.
// Settings groups shares per person per machine only, so person never
// reaches another machine's shares.
func (d *Desk) RevokeGuestPerson(ctx context.Context, token, machine, person string) error {
	if person == "" {
		return errors.New("no person to remove")
	}
	view, err := d.settingsView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	_, err = view.client.GuestRevoke(ctx, herdrapi.GuestRevokeParams{Machine: guestMachineAlias(machine), Person: &person})
	return err
}

// RemoveGuestDevice drops one device (its fingerprint, deviceID) from the
// account-bound share guestID on machine (guest.remove_device); the person's
// other devices keep it. A share herdr no longer has active (guest_not_found:
// revoked meanwhile, from another device or page) is gone for that device
// too, so it is done.
func (d *Desk) RemoveGuestDevice(ctx context.Context, token, machine, guestID, deviceID string) error {
	view, err := d.settingsView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	_, err = view.client.GuestRemoveDevice(ctx, herdrapi.GuestRemoveDeviceParams{Machine: guestMachineAlias(machine), GuestID: guestID, Fingerprint: deviceID})
	if api := (*bridge.APIError)(nil); errors.As(err, &api) && api.Code == "guest_not_found" {
		return nil
	}
	return err
}
