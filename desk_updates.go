package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The accepted Swift ServerRequirement.current, not the desktop build date.
const updateMinCommitTime int64 = 1793108998

type serverUpdateState struct {
	Known        bool                                `json:"known"`
	Capabilities *herdrapi.ServerCapabilities        `json:"capabilities,omitempty"`
	Version      string                              `json:"version"`
	Check        *herdrapi.ResponseResultUpdateCheck `json:"check,omitempty"`
	Pending      *herdrapi.UpdateAttempt             `json:"pending,omitempty"`
	Attempt      *herdrapi.UpdateAttempt             `json:"attempt,omitempty"`
	Flow         string                              `json:"flow"`
	Code         string                              `json:"code"`
	Message      string                              `json:"message"`
	RestartLater bool                                `json:"restartLater"`
	Missing      []string                            `json:"missing"`
	Forbidden    bool                                `json:"forbidden"`
}

// An update belongs to the machine/session, not to a Settings sheet or SSH
// connection. A live handoff drops SSH; only that same identity can resume it.
// op serializes refresh/apply; mu protects short snapshots and follower progress.
// Neither is acquired while holding Desk.mu.
type serverUpdate struct {
	op                                sync.Mutex
	mu                                sync.Mutex
	machine, session                  string
	state                             serverUpdateState
	targetID, targetBuild, previousID string
	following                         bool
}

func (d *Desk) settingsUpdate(token string) (*settingsSession, *serverUpdate, error) {
	view, err := d.settingsView(token)
	if err != nil {
		return nil, nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(view.at) || view.ctx.Err() != nil || view.at.link.guest != nil {
		return nil, nil, ErrSessionChanged
	}
	machine, session := view.at.link.id, sessionKey(view.at.link.session)
	key := machine + "\x00" + session
	if d.updates == nil {
		d.updates = make(map[string]*serverUpdate)
	}
	u := d.updates[key]
	if u == nil {
		u = &serverUpdate{machine: machine, session: session, state: serverUpdateState{Flow: "idle"}}
		d.updates[key] = u
	}
	return view, u, nil
}

func (u *serverUpdate) snapshot() serverUpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state // decoded replies are immutable once published
}

func updateMissing(caps *herdrapi.ServerCapabilities) []string {
	missing := []string{}
	if caps == nil || !caps.AgentGroups {
		missing = append(missing, "folders")
	}
	if caps == nil || !caps.AgentAvatar {
		missing = append(missing, "avatars")
	}
	if caps == nil || !caps.AgentAnswer {
		missing = append(missing, "answers from notifications")
	}
	return missing
}

func updateOffer(s serverUpdateState) bool {
	c := s.Check
	if s.Forbidden || c == nil || !c.UpdateAvailable || c.Latest == nil || c.Latest.BuildID == "" {
		return false
	}
	if c.Mode != herdrapi.UpdateModeLive && c.Mode != herdrapi.UpdateModeRestartRequired {
		return false
	}
	meets := len(updateMissing(s.Capabilities)) == 0 && s.Capabilities != nil && s.Capabilities.ServerUpdate && (c.Running.CommitTime == nil || *c.Running.CommitTime >= updateMinCommitTime)
	if !meets && c.Latest.CommitTime < updateMinCommitTime {
		return false
	}
	if s.Pending != nil && s.Pending.Outcome != nil && *s.Pending.Outcome == herdrapi.UpdateOutcomeDownloadedRestartRequired && (c.Running.BuildID == nil || *c.Running.BuildID != s.Pending.BuildID) {
		return false
	}
	return true
}

// refresh must be called under op. It never erases a running/finished attempt.
func (d *Desk) refreshUpdate(ctx context.Context, u *serverUpdate, client *engine.Client) error {
	pong, err := client.Ping(ctx)
	if err != nil {
		return err
	}
	u.mu.Lock()
	u.state.Known, u.state.Capabilities, u.state.Version = true, pong.Capabilities, pong.Version
	u.mu.Unlock()
	if pong.Capabilities == nil || !pong.Capabilities.ServerUpdate {
		return nil
	}
	check, err := client.UpdateCheck(ctx)
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			u.mu.Lock()
			u.state.Forbidden = api.Code == "guest_forbidden"
			u.state.Code, u.state.Message = api.Code, api.Message
			u.mu.Unlock()
		}
		return err
	}
	status, err := client.UpdateStatus(ctx)
	if err != nil {
		return err
	}
	u.mu.Lock()
	u.state.Check, u.state.Forbidden = &check, false
	u.state.Pending = nil
	if a := status.Attempt; a != nil {
		if a.Outcome != nil && *a.Outcome == herdrapi.UpdateOutcomeDownloadedRestartRequired {
			u.state.Pending = a
		}
		if a.Outcome == nil && u.state.Flow == "idle" && !u.following {
			u.state.Flow, u.state.Attempt, u.state.RestartLater = "running", a, a.RestartLater
			u.state.Missing = updateMissing(pong.Capabilities)
			u.targetID, u.targetBuild, u.previousID = a.AttemptID, "", ""
			u.following = true
			go d.followUpdate(u)
		}
	}
	u.mu.Unlock()
	return nil
}

func (d *Desk) SettingsServerUpdate(ctx context.Context, token string, refresh bool) (string, error) {
	view, u, err := d.settingsUpdate(token)
	if err != nil {
		return "", err
	}
	if refresh {
		u.op.Lock()
		ctx, cancel := viewRequest(ctx, view.ctx)
		err = d.refreshUpdate(ctx, u, view.client)
		cancel()
		u.op.Unlock()
		if err != nil {
			return "", err
		}
	}
	if view.ctx.Err() != nil {
		return "", ErrSessionChanged
	}
	data, err := json.Marshal(u.snapshot())
	return string(data), err
}

// The UI supplies the exact build/mode it confirmed, never an unqualified
// "install latest". Uncertain apply results are followed, never resubmitted.
func (d *Desk) ApplySettingsServerUpdate(ctx context.Context, token, buildID string, restartLater bool) error {
	view, u, err := d.settingsUpdate(token)
	if err != nil {
		return err
	}
	u.op.Lock()
	defer u.op.Unlock()
	s := u.snapshot()
	if s.Flow != "idle" || !updateOffer(s) || s.Check.Latest.BuildID != buildID || (s.Check.Mode == herdrapi.UpdateModeRestartRequired) != restartLater {
		return errors.New("the offered update changed; check it again before confirming")
	}
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	previous, err := view.client.UpdateStatus(ctx)
	if err != nil {
		return err
	} // no apply was sent
	if err = ctx.Err(); err != nil {
		return err
	}
	u.mu.Lock()
	u.state.Flow, u.state.Attempt, u.state.RestartLater = "running", nil, restartLater
	u.state.Code, u.state.Message = "", ""
	u.state.Missing = updateMissing(s.Capabilities)
	u.targetID, u.targetBuild, u.previousID = "", buildID, ""
	if previous.Attempt != nil {
		u.previousID = previous.Attempt.AttemptID
	}
	u.mu.Unlock()
	applied, err := view.client.UpdateApply(ctx, herdrapi.ServerUpdateApplyParams{BuildID: buildID, RestartLater: restartLater})
	u.mu.Lock()
	defer u.mu.Unlock()
	var api *bridge.APIError
	var unsupported *engine.ErrUnsupported
	if errors.As(err, &api) || errors.As(err, &unsupported) {
		u.state.Flow, u.state.Message = "refused", err.Error()
		if api != nil {
			u.state.Code, u.state.Message = api.Code, api.Message
		} else {
			u.state.Code = "update_unsupported_install"
		}
		return nil
	}
	if err == nil {
		u.targetID = applied.AttemptID
	}
	u.following = true
	go d.followUpdate(u)
	return nil
}

// Retrying a definite failure checks afresh before a new confirmation. Looking
// again after silence only polls the existing target; it cannot install anything.
func (d *Desk) RecheckSettingsServerUpdate(ctx context.Context, token string, lookAgain bool) error {
	view, u, err := d.settingsUpdate(token)
	if err != nil {
		return err
	}
	u.op.Lock()
	defer u.op.Unlock()
	u.mu.Lock()
	if u.following || u.state.Flow == "running" {
		u.mu.Unlock()
		return errors.New("an update is already being followed")
	}
	if lookAgain {
		if u.state.Flow != "lostTrack" {
			u.mu.Unlock()
			return errors.New("there is no lost update to follow")
		}
		u.state.Flow, u.following = "running", true
		go d.followUpdate(u)
		u.mu.Unlock()
		return nil
	}
	if u.state.Flow == "lostTrack" {
		u.mu.Unlock()
		return errors.New("look again before starting another update")
	}
	old := u.state
	u.state.Flow, u.state.Attempt = "idle", nil
	u.mu.Unlock()
	ctx, cancel := viewRequest(ctx, view.ctx)
	defer cancel()
	if err = d.refreshUpdate(ctx, u, view.client); err != nil {
		u.mu.Lock()
		u.state.Flow, u.state.Attempt = old.Flow, old.Attempt
		u.mu.Unlock()
		return err
	}
	u.mu.Lock()
	// A refresh may have discovered an already-running attempt.
	if !u.following {
		u.state.Flow, u.state.Attempt, u.state.Code, u.state.Message = "idle", nil, "", ""
		if old.Flow == "finished" && old.Attempt != nil && old.Attempt.Outcome != nil && (*old.Attempt.Outcome == herdrapi.UpdateOutcomeRolledBack || *old.Attempt.Outcome == herdrapi.UpdateOutcomeNeedsAttention) {
			u.state.Flow, u.state.Attempt = old.Flow, old.Attempt
		}
	}
	u.mu.Unlock()
	return nil
}

func (d *Desk) updateClient(u *serverUpdate) *engine.Client {
	d.mu.Lock()
	defer d.mu.Unlock()
	l := d.link
	if l == nil || l.guest != nil || l.id != u.machine || sessionKey(l.session) != u.session {
		return nil
	}
	client, err := l.engineLocked()
	if err != nil {
		return nil
	}
	return client
}

func (d *Desk) followUpdate(u *serverUpdate) {
	silent, foreign := 0, 0
	for {
		answered, other := false, false
		var attempt *herdrapi.UpdateAttempt
		if client := d.updateClient(u); client != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			status, err := client.UpdateStatus(ctx)
			cancel()
			if err == nil {
				attempt, other = status.Attempt, true
			}
		}
		u.mu.Lock()
		if attempt != nil && ((u.targetID != "" && attempt.AttemptID == u.targetID) || (u.targetID == "" && attempt.BuildID == u.targetBuild && attempt.AttemptID != u.previousID)) {
			answered, other = true, false
			u.state.Attempt = attempt
			if attempt.Outcome != nil {
				u.state.Flow, u.following = "finished", false
				u.mu.Unlock()
				// Refresh the running build/capabilities after the handoff. The
				// old connection is never reused and a different host is ignored.
				if client := d.updateClient(u); client != nil {
					u.op.Lock()
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					_ = d.refreshUpdate(ctx, u, client)
					cancel()
					u.op.Unlock()
				}
				return
			}
		}
		if answered {
			silent = 0
		} else {
			silent++
		}
		if u.targetID == "" && u.state.Attempt == nil {
			if other {
				foreign++
			} else {
				foreign = 0
			}
			if foreign >= 10 {
				u.state.Flow, u.following = "idle", false
				u.mu.Unlock()
				return
			}
		}
		if silent >= 120 {
			u.state.Flow, u.following = "lostTrack", false
			u.mu.Unlock()
			return
		}
		u.mu.Unlock()
		time.Sleep(time.Second)
	}
}
