package main

import (
	"encoding/json"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// The machine in herdrup's Settings references has no pending update: its
// update card is hidden. herdrup 9845ecf ServerUpdate.swift 367-369
// (ServerRequirement.current) and 558-560 hide the card only for a server
// that advertises these features, runs a commit at or after this time, and
// has no newer build. The native fixtures' ping predates server_update, so
// -current supplies that state instead of hiding the card in the app.
const currentCommitTime int64 = 1_793_108_998

var currentFeatures = []string{"agent_groups", "agent_avatar", "agent_answer", "server_update"}

type sessionHandler = func(session, method string, params json.RawMessage) (any, *fakeherdr.APIError)

// serveCurrent makes s answer as a herdr that needs no update: ping also
// advertises currentFeatures, server.update_check reports the running build
// as the newest, and server.update_status has no attempt.
func serveCurrent(s *fakeherdr.Server) {
	next := s.HandleSession
	if next == nil {
		handle := s.Handle
		next = func(_, method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			return handle(method, params)
		}
	}
	s.HandleSession = currentHandler(next)
}

func currentHandler(next sessionHandler) sessionHandler {
	pong := func(session string) (map[string]any, *fakeherdr.APIError) {
		value, apiErr := next(session, "ping", nil)
		if apiErr != nil {
			return nil, apiErr
		}
		data, err := json.Marshal(value)
		if err != nil {
			return nil, &fakeherdr.APIError{Code: "internal", Message: err.Error()}
		}
		var reply map[string]any
		if err := json.Unmarshal(data, &reply); err != nil {
			return nil, &fakeherdr.APIError{Code: "internal", Message: err.Error()}
		}
		caps, _ := reply["capabilities"].(map[string]any)
		if caps == nil {
			caps = map[string]any{}
		}
		for _, name := range currentFeatures {
			caps[name] = true
		}
		reply["capabilities"] = caps
		return reply, nil
	}
	return func(session, method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "ping":
			return pong(session)
		case "server.update_check":
			reply, apiErr := pong(session)
			if apiErr != nil {
				return nil, apiErr
			}
			return map[string]any{
				"type": "update_check", "update_available": false, "mode": "live",
				"running": map[string]any{"version": reply["version"], "protocol": reply["protocol"], "commit_time": currentCommitTime},
			}, nil
		case "server.update_status":
			return map[string]any{"type": "update_status"}, nil
		}
		return next(session, method, params)
	}
}
