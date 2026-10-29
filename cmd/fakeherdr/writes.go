package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// writes is the state behind the methods that change something, kept in
// memory so herdrup-cli can exercise them without a real herdr: agent
// folders and stars, gram messages, avatars and upload staging.
type writes struct {
	mu      sync.Mutex
	groups  herdrapi.ResponseResultAgentGroups
	grams   []herdrapi.GramMessageInfo
	read    map[string]bool
	seq     int
	uploads map[string][]byte
	// uploadStream is whether ping advertises gram_upload_stream.
	uploadStream bool
}

func newWrites() *writes {
	return &writes{
		groups:  herdrapi.ResponseResultAgentGroups{Folders: []herdrapi.AgentGroupFolder{}, Stars: []string{}},
		read:    map[string]bool{},
		uploads: map[string][]byte{},
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
	case "gram.send", "gram.post":
		var p struct {
			Text string                   `json:"text"`
			File *herdrapi.GramFileUpload `json:"file"`
		}
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		if p.File != nil {
			if _, staged := w.uploads[p.File.UploadID]; !staged {
				return nil, apiErr("gram_file_error", "no upload "+p.File.UploadID), true
			}
			delete(w.uploads, p.File.UploadID)
		}
		w.seq++
		m := herdrapi.GramMessageInfo{ID: "gram-fake-" + strconv.Itoa(w.seq), Text: p.Text,
			CreatedUnixMs: uint64(time.Now().UnixMilli()), Direction: herdrapi.GramDirectionOwnerToAgent, From: "owner"}
		w.grams = append(w.grams, m)
		return result(herdrapi.ResponseResultGramSent{Message: m, StoreID: "fake"}), nil, true
	case "gram.list":
		msgs := make([]herdrapi.GramMessageInfo, 0, len(w.grams))
		unread := uint64(0)
		for _, m := range slices.Backward(w.grams) {
			m.ReadByOwner = w.read[m.ID]
			if !m.ReadByOwner {
				unread++
			}
			msgs = append(msgs, m)
		}
		return result(herdrapi.ResponseResultGramList{Messages: msgs, UnreadCount: unread, Digest: strconv.Itoa(w.seq), StoreID: "fake"}), nil, true
	case "gram.mark_read":
		var p herdrapi.GramMarkReadParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		ids := p.IDs
		if p.ID != nil {
			ids = append(ids, *p.ID)
		}
		for _, id := range ids {
			w.read[id] = true
		}
		return result(herdrapi.ResponseResultOk{}), nil, true
	case "gram.delete":
		var p herdrapi.GramDeleteParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		i := slices.IndexFunc(w.grams, func(m herdrapi.GramMessageInfo) bool { return m.ID == p.ID })
		if i < 0 {
			return nil, apiErr("gram_not_found", p.ID), true
		}
		w.grams = slices.Delete(w.grams, i, i+1)
		return result(herdrapi.ResponseResultOk{}), nil, true
	case "gram.upload_chunk":
		var p herdrapi.GramUploadChunkParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		if e := w.append(p.UploadID, p.Offset, p.DataBase64); e != nil {
			return nil, e, true
		}
		return result(herdrapi.ResponseResultOk{}), nil, true
	}
	return nil, nil, false
}

// append stages one chunk of an upload. w.mu must be held.
func (w *writes) append(id string, off uint64, b64 string) *fakeherdr.APIError {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return apiErr("invalid_params", err.Error())
	}
	if uint64(len(w.uploads[id])) != off {
		return apiErr("invalid_params", fmt.Sprintf("offset %d, have %d bytes", off, len(w.uploads[id])))
	}
	w.uploads[id] = append(w.uploads[id], data...)
	return nil
}

// duplex answers gram.upload.stream on `remote-api-bridge`: an ok
// acknowledgement, then one reply per chunk frame until the client closes.
func (w *writes) duplex(_ context.Context, id, method string, params json.RawMessage, read func() ([]byte, error), emit func([]byte) error) {
	reply := func(v any) error {
		b, _ := json.Marshal(v)
		return emit(b)
	}
	if method != "gram.upload.stream" {
		_ = reply(map[string]any{"id": id, "error": apiErr("invalid_request", "unknown variant `"+method+"`")})
		return
	}
	var p herdrapi.GramUploadStreamParams
	_ = json.Unmarshal(params, &p)
	if reply(map[string]any{"id": id, "result": result(herdrapi.ResponseResultOk{})}) != nil {
		return
	}
	for {
		line, err := read()
		if err != nil {
			return
		}
		var f herdrapi.GramUploadFrame
		if json.Unmarshal(line, &f) != nil {
			return
		}
		w.mu.Lock()
		e := w.append(p.UploadID, f.Offset, f.DataBase64)
		w.mu.Unlock()
		if e != nil {
			_ = reply(herdrapi.GramUploadFrameReply{Seq: f.Seq, Error: &herdrapi.ErrorBody{Code: e.Code, Message: e.Message}})
			return
		}
		if reply(herdrapi.GramUploadFrameReply{Seq: f.Seq, Ok: true}) != nil {
			return
		}
	}
}
