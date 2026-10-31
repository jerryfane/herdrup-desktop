package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
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
	var state string
	if err := json.Unmarshal(replies["state"], &state); err != nil {
		return fmt.Errorf("reference state: %w", err)
	}
	var gram *fakeherdr.Gram
	if raw := replies["gram.list"]; raw != nil {
		var list struct {
			Messages []herdrapi.GramMessageInfo `json:"messages"`
		}
		var files map[string]struct {
			Data string `json:"data_base64"`
		}
		if err := json.Unmarshal(raw, &list); err != nil {
			return fmt.Errorf("reference gram.list: %w", err)
		}
		if raw := replies["gram.get_file"]; raw != nil {
			if err := json.Unmarshal(raw, &files); err != nil {
				return fmt.Errorf("reference gram.get_file: %w", err)
			}
		}
		gram = fakeherdr.NewGram("native-reference")
		// The wire list is newest first; the store accepts oldest first.
		for i := len(list.Messages) - 1; i >= 0; i-- {
			message := list.Messages[i]
			var data []byte
			if file, ok := files[message.ID]; ok {
				var err error
				data, err = base64.StdEncoding.DecodeString(file.Data)
				if err != nil {
					return fmt.Errorf("reference file %s: %w", message.ID, err)
				}
			}
			gram.Add(message, data)
		}
		server.Duplex = gram.Duplex
	}
	fallback := server.Handle
	server.HandleSession = func(session, method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		if gram != nil {
			// Match the native fixture's deliberately unanswered first fetch.
			if method == "gram.list" && state == "gram-loading" {
				select {}
			}
			if value, err, handled := gram.Handle(method, params); handled {
				return value, err
			}
		}
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
