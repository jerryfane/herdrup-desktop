package main

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// writes is the state behind the methods that change something, kept in
// memory so herdrup-cli can exercise them without a real herdr: agent
// folders and stars, gram messages, avatars and upload staging.
type writes struct {
	mu     sync.Mutex
	groups herdrapi.ResponseResultAgentGroups
	// gram answers gram.*.
	gram *fakeherdr.Gram
	// uploadStream is whether ping advertises gram_upload_stream.
	uploadStream bool
}

func newWrites() *writes {
	return &writes{
		groups: herdrapi.ResponseResultAgentGroups{Folders: []herdrapi.AgentGroupFolder{}, Stars: []string{}},
		gram:   fakeherdr.NewGram("fake"),
	}
}

func apiErr(code, msg string) *fakeherdr.APIError {
	return &fakeherdr.APIError{Code: code, Message: msg}
}

// result tags a result struct with its ResponseResult type.
func result(v herdrapi.ResponseResultVariant) any {
	return herdrapi.ResponseResult{Value: v}
}

// handle answers the write methods; ok is false for any other method.
func (w *writes) handle(method string, params json.RawMessage) (res any, err *fakeherdr.APIError, ok bool) {
	if res, err, ok := w.gram.Handle(method, params); ok {
		return res, err, true
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	decode := func(p any) *fakeherdr.APIError {
		if len(params) == 0 {
			return nil
		}
		if e := json.Unmarshal(params, p); e != nil {
			return apiErr("invalid_params", e.Error())
		}
		return nil
	}
	switch method {
	case "agent.groups.get":
		return result(w.groups), nil, true
	case "agent.groups.set":
		var p herdrapi.AgentGroupsSetParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		if p.Revision != w.groups.Revision {
			return nil, &fakeherdr.APIError{Code: "groups_conflict",
				Message: fmt.Sprintf("agent groups changed: revision %d is stored, not %d", w.groups.Revision, p.Revision),
				Current: w.groups}, true
		}
		w.groups = herdrapi.ResponseResultAgentGroups{Revision: p.Revision + 1, Folders: p.Folders, Stars: p.Stars}
		return result(w.groups), nil, true
	case "agent.avatar.set":
		var p herdrapi.AgentAvatarSetParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		if p.Target == "" {
			return nil, apiErr("agent_not_found", "no target"), true
		}
		return result(herdrapi.ResponseResultAgentAvatarSet{}), nil, true
	}
	return nil, nil, false
}
