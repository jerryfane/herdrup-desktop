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
