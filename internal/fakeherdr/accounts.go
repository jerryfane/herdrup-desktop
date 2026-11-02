package fakeherdr

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
)

// Accounts is an opt-in local Settings fixture. It never executes a command or
// authenticates with a provider. Only native-smoke-code changes its fake identity.
type Accounts struct {
	mu       sync.Mutex
	next     int
	accounts []map[string]any
	panes    map[string]*accountPane
}
type accountPane struct{ pending, output, account string }

func NewAccounts() *Accounts {
	return &Accounts{panes: make(map[string]*accountPane), accounts: []map[string]any{
		{"id": "claude-smoke", "kind": "claude", "label": "Claude · smoke", "config_dir": "/fixture/claude-smoke", "active": true, "readiness": map[string]any{"ready": false, "detail": "Sign in before moving agents to this account."}},
		{"id": "codex-work", "kind": "codex", "label": "Codex · work", "config_dir": "/fixture/codex-work", "email": "work@example.invalid", "active": false, "usage": map[string]any{"plan": "Plus", "source": "local", "windows": []map[string]any{{"label": "5h", "used_percent": 100}, {"label": "Weekly", "used_percent": 42}}}},
		{"id": "claude-ready", "kind": "claude", "label": "Claude · ready", "config_dir": "/fixture/claude-ready", "email": "ready@example.invalid", "active": true, "readiness": map[string]any{"ready": true}},
	}}
}

func (x *Accounts) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	switch method {
	case "accounts.list", "accounts.create", "accounts.remove", "agent.restart", "pane.split", "pane.close", "pane.read", "pane.send_text", "pane.send_keys":
	default:
		return nil, nil, false
	}
	var p struct {
		ID      string   `json:"id"`
		Kind    string   `json:"kind"`
		Label   string   `json:"label"`
		Pane    string   `json:"pane_id"`
		Text    string   `json:"text"`
		Keys    []string `json:"keys"`
		Account string   `json:"account"`
		Target  string   `json:"target"`
		Focus   bool     `json:"focus"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &APIError{Code: "invalid_request", Message: err.Error()}, true
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	accountList := func() any {
		// The dispatcher encodes after Handle returns; snapshot under the lock.
		encoded, _ := json.Marshal(map[string]any{"type": "accounts_list", "accounts": x.accounts})
		return json.RawMessage(encoded)
	}
	ok := func() (any, *APIError, bool) { return map[string]any{"type": "ok"}, nil, true }
	missing := func() (any, *APIError, bool) {
		return nil, &APIError{Code: "not_found", Message: "fixture account or pane not found"}, true
	}
	switch method {
	case "accounts.list":
		return accountList(), nil, true
	case "accounts.create":
		if strings.TrimSpace(p.Label) == "" || !slices.Contains([]string{"claude", "codex", "kimi"}, p.Kind) {
			return nil, &APIError{Code: "invalid_request", Message: "kind and label required"}, true
		}
		x.next++
		id := fmt.Sprintf("%s-added-%d", p.Kind, x.next)
		x.accounts = append(x.accounts, map[string]any{"id": id, "kind": p.Kind, "label": p.Label, "config_dir": "/fixture/" + id, "active": true})
		return accountList(), nil, true
	case "accounts.remove":
		for i, account := range x.accounts {
			if account["id"] == p.ID {
				x.accounts = slices.Delete(x.accounts, i, i+1)
				return accountList(), nil, true
			}
		}
		return missing()
	case "agent.restart":
		for _, account := range x.accounts {
			if account["id"] != p.Account {
				continue
			}
			if ready, ok := account["readiness"].(map[string]any); ok && ready["ready"] == false {
				return nil, &APIError{Code: "account_not_ready", Message: "fixture account is not ready"}, true
			}
			return map[string]any{"type": "agent_info", "agent": map[string]any{"pane_id": p.Target, "agent": account["kind"], "account_id": p.Account, "agent_status": "idle"}}, nil, true
		}
		return missing()
	case "pane.split":
		if p.Focus {
			return nil, &APIError{Code: "invalid_request", Message: "auth fixture requires an unfocused pane"}, true
		}
		x.next++
		id := fmt.Sprintf("auth:%d", x.next)
		x.panes[id] = &accountPane{}
		return map[string]any{"type": "pane_info", "pane": map[string]any{"pane_id": id, "tab_id": "fixture", "agent_status": "idle"}}, nil, true
	}
	pane, exists := x.panes[p.Pane]
	if !exists {
		if strings.HasPrefix(p.Pane, "auth:") {
			return missing()
		}
		return nil, nil, false
	}
	switch method {
	case "pane.close":
		delete(x.panes, p.Pane)
		return ok()
	case "pane.read":
		return map[string]any{"type": "pane_read", "read": map[string]any{"pane_id": p.Pane, "tab_id": "fixture", "source": "recent_unwrapped", "format": "text", "revision": 1, "text": pane.output}}, nil, true
	case "pane.send_text":
		pane.pending += p.Text
		return ok()
	case "pane.send_keys":
		if !slices.Contains(p.Keys, "Enter") {
			return ok()
		}
		text := pane.pending
		pane.pending = ""
		if strings.HasPrefix(text, "env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR=") {
			for _, account := range x.accounts {
				if !strings.Contains(text, "'"+account["config_dir"].(string)+"'") {
					continue
				}
				pane.account = account["id"].(string)
				if strings.HasSuffix(text, " auth logout") {
					delete(account, "email")
					account["readiness"] = map[string]any{"ready": false}
					pane.output = "Logged out\n"
				} else {
					pane.output = "Open https://example.invalid/fixture-sign-in\nAwaiting authorization code\n"
				}
				return ok()
			}
			return missing()
		}
		if text == "native-smoke-code" {
			for _, account := range x.accounts {
				if account["id"] == pane.account {
					account["email"] = "signed-in@example.invalid"
					account["readiness"] = map[string]any{"ready": true}
				}
			}
			// Real Claude may print no success phrase; identity is authoritative.
			pane.output += "Ready\n"
		} else if text == "phrase-only" {
			pane.output += "Login successful\n"
		} else {
			pane.output += "Invalid authorization code\n"
		}
		return ok()
	}
	return nil, nil, false
}
