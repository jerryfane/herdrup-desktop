package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// Native reference fixtures contain the daemon's actual response objects. Serve
// those over SSH rather than injecting a different roster into the renderer.
func serveReferenceResponses(server *fakeherdr.Server, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var replies map[string]json.RawMessage
	if err := json.Unmarshal(data, &replies); err != nil {
		return fmt.Errorf("reference responses: %w", err)
	}
	if replies["agent.list"] == nil || replies["ping"] == nil {
		return fmt.Errorf("reference responses need ping and agent.list")
	}
	var avatars, sessions map[string]json.RawMessage
	for key, target := range map[string]*map[string]json.RawMessage{
		"agent.avatar.get": &avatars, "agent.list in session": &sessions,
	} {
		if raw := replies[key]; raw != nil {
			if err := json.Unmarshal(raw, target); err != nil {
				return fmt.Errorf("reference %s: %w", key, err)
			}
		}
	}
	if raw := replies["herdr session list --json"]; raw != nil {
		server.SessionList = string(raw)
	}
	fallback := server.Handle
	server.HandleSession = func(session, method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		if method == "agent.list" && session != "" && session != "default" {
			if response := sessions[session]; response != nil {
				return response, nil
			}
		}
		if method == "agent.avatar.get" && avatars != nil {
			var request struct {
				SHA256 string `json:"sha256"`
			}
			if err := json.Unmarshal(params, &request); err != nil {
				return nil, &fakeherdr.APIError{Code: "invalid_request", Message: err.Error()}
			}
			if response := avatars[request.SHA256]; response != nil {
				return response, nil
			}
			return nil, &fakeherdr.APIError{Code: "not_found", Message: "avatar is absent from reference fixture"}
		}
		if response := replies[method]; response != nil {
			return response, nil
		}
		return fallback(method, params)
	}
	return nil
}
