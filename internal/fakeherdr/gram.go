package fakeherdr

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Gram limits as herdr's (src/persist/gram_files.rs, src/api/schema/gram.rs).
const (
	GramListMaxLimit  = 500
	GramMaxChunkBytes = 512 << 10
	GramMaxFileBytes  = 100 << 20
)

// Gram is a herdr Gram store answering gram.* for the owner as herdr does
// (src/app/api/gram.rs): newest-first lists with a digest over the store
// id and the whole filtered list, gram_list_unchanged for a matching head
// poll, before_id paging with has_more, an unread count over the whole
// filtered list, staged uploads attached by gram.post, and file reads
// whole or in 512 KiB chunks. Methods are safe for concurrent use.
type Gram struct {
	// Fail, when set, is asked before every gram.* request; an error it
	// returns is the answer.
	Fail func(method string, params json.RawMessage) *APIError

	mu      sync.Mutex
	storeID string
	msgs    []herdrapi.GramMessageInfo // oldest first, as herdr stores them
	files   map[string][]byte          // by message id
	uploads map[string][]byte
	seq     int
	calls   []GramCall
}

// GramCall is one gram.* request the fake answered.
type GramCall struct {
	Method string
	Params json.RawMessage
}

// NewGram returns an empty store with the given store id.
func NewGram(storeID string) *Gram {
	return &Gram{storeID: storeID, files: map[string][]byte{}, uploads: map[string][]byte{}}
}

// SetStoreID changes the store id, as a client pointed at another machine
// would see.
func (g *Gram) SetStoreID(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.storeID = id
}

// Add appends m as the newest message. data, when not nil, becomes its file:
// m.File's size and sha256 are set from it (name and mime are kept).
func (g *Gram) Add(m herdrapi.GramMessageInfo, data []byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if data != nil {
		f := herdrapi.GramFileInfo{Mime: "application/octet-stream"}
		if m.File != nil {
			f = *m.File
		}
		sum := sha256.Sum256(data)
		f.Size, f.SHA256 = uint64(len(data)), hex.EncodeToString(sum[:])
		m.File = &f
		g.files[m.ID] = data
	}
	g.msgs = append(g.msgs, m)
}

// Update changes the stored message id, as another client or an agent
// would (a grab, a read elsewhere, an expired file).
func (g *Gram) Update(id string, change func(*herdrapi.GramMessageInfo)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if i := g.index(id); i >= 0 {
		change(&g.msgs[i])
		if g.msgs[i].File == nil {
			delete(g.files, id)
		}
	}
}

// Messages returns the stored messages, oldest first.
func (g *Gram) Messages() []herdrapi.GramMessageInfo {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.msgs)
}

// Calls returns every gram.* request answered, in order.
func (g *Gram) Calls() []GramCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.calls)
}

// Staged returns the bytes staged under upload id.
func (g *Gram) Staged(id string) ([]byte, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	b, ok := g.uploads[id]
	return b, ok
}

func (g *Gram) index(id string) int {
	return slices.IndexFunc(g.msgs, func(m herdrapi.GramMessageInfo) bool { return m.ID == id })
}

func gramResult(v herdrapi.ResponseResultVariant) any { return herdrapi.ResponseResult{Value: v} }

func gramErr(code, msg string) *APIError { return &APIError{Code: code, Message: msg} }

// Handle answers a gram.* request; ok is false for any other method.
func (g *Gram) Handle(method string, params json.RawMessage) (res any, apiErr *APIError, ok bool) {
	switch method {
	case "gram.list", "gram.post", "gram.send", "gram.mark_read", "gram.delete", "gram.upload_chunk",
		"gram.upload.discard", "gram.get_file", "gram.get_file_chunk":
	default:
		return nil, nil, false
	}
	if g.Fail != nil {
		if e := g.Fail(method, params); e != nil {
			g.mu.Lock()
			g.calls = append(g.calls, GramCall{method, params})
			g.mu.Unlock()
			return nil, e, true
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, GramCall{method, params})
	decode := func(p any) *APIError {
		if len(params) == 0 {
			return nil
		}
		if e := json.Unmarshal(params, p); e != nil {
			return gramErr("invalid_params", e.Error())
		}
		return nil
	}
	switch method {
	case "gram.list":
		var p herdrapi.GramListParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		res, e := g.list(p)
		return res, e, true
	case "gram.post", "gram.send":
		var p struct {
			Text string                   `json:"text"`
			To   *string                  `json:"to"`
			From *string                  `json:"from"`
			File *herdrapi.GramFileUpload `json:"file"`
		}
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		g.seq++
		m := herdrapi.GramMessageInfo{
			ID: "gram-fake-" + strconv.Itoa(g.seq), Text: p.Text, To: p.To,
			CreatedUnixMs: uint64(time.Now().UnixMilli()), Direction: herdrapi.GramDirectionOwnerToAgent, From: "owner",
		}
		if method == "gram.send" {
			m.Direction, m.To, m.From = herdrapi.GramDirectionAgentToOwner, nil, "agent"
			if p.From != nil {
				m.From = *p.From
			}
		}
		if p.File != nil {
			data, staged := g.uploads[p.File.UploadID]
			if !staged {
				return nil, gramErr("invalid_params", "no staged upload with that id; upload the file chunks first"), true
			}
			delete(g.uploads, p.File.UploadID)
			sum := sha256.Sum256(data)
			mime := p.File.Mime
			if mime == "" {
				mime = "application/octet-stream"
			}
			m.File = &herdrapi.GramFileInfo{Name: p.File.Name, Mime: mime, Size: uint64(len(data)), SHA256: hex.EncodeToString(sum[:])}
			g.files[m.ID] = data
		} else if p.Text == "" {
			return nil, gramErr("invalid_params", "text is empty"), true
		}
		g.msgs = append(g.msgs, m)
		return gramResult(herdrapi.ResponseResultGramSent{Message: m, StoreID: g.storeID}), nil, true
	case "gram.mark_read":
		var p herdrapi.GramMarkReadParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		ids := p.IDs
		if p.ID != nil {
			ids = append(ids, *p.ID)
		}
		if len(ids) == 0 {
			return nil, gramErr("invalid_params", "pass id or ids"), true
		}
		for _, id := range ids {
			if g.index(id) < 0 {
				return nil, gramErr("not_found", "no gram message with that id"), true
			}
		}
		for _, id := range ids {
			i := g.index(id)
			if g.msgs[i].Direction == herdrapi.GramDirectionAgentToOwner {
				g.msgs[i].ReadByOwner = true
			}
		}
		return gramResult(herdrapi.ResponseResultOk{}), nil, true
	case "gram.delete":
		var p herdrapi.GramDeleteParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		i := g.index(p.ID)
		if i < 0 {
			return nil, gramErr("not_found", "no gram message with that id"), true
		}
		g.msgs = slices.Delete(g.msgs, i, i+1)
		delete(g.files, p.ID)
		return gramResult(herdrapi.ResponseResultOk{}), nil, true
	case "gram.upload_chunk":
		var p herdrapi.GramUploadChunkParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		if e := g.appendChunk(p.UploadID, p.Offset, p.DataBase64); e != nil {
			return nil, e, true
		}
		return gramResult(herdrapi.ResponseResultOk{}), nil, true
	case "gram.upload.discard":
		var p herdrapi.GramUploadDiscardParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		_, had := g.uploads[p.UploadID]
		delete(g.uploads, p.UploadID)
		return gramResult(herdrapi.ResponseResultGramUploadDiscarded{Discarded: had}), nil, true
	case "gram.get_file", "gram.get_file_chunk":
		var p herdrapi.GramGetFileChunkParams
		if e := decode(&p); e != nil {
			return nil, e, true
		}
		i := g.index(p.ID)
		if i < 0 {
			return nil, gramErr("not_found", "no gram message with that id"), true
		}
		f := g.msgs[i].File
		if f == nil {
			return nil, gramErr("no_file", "that message has no attached file"), true
		}
		data := g.files[p.ID]
		if method == "gram.get_file" {
			return gramResult(herdrapi.ResponseResultGramFileContent{Name: f.Name, Mime: f.Mime, Size: f.Size,
				DataBase64: base64.StdEncoding.EncodeToString(data)}), nil, true
		}
		if p.Offset > uint64(len(data)) {
			return nil, gramErr("invalid_params", "file offset exceeds size"), true
		}
		end := min(uint64(len(data)), p.Offset+GramMaxChunkBytes)
		return gramResult(herdrapi.ResponseResultGramFileChunk{Name: f.Name, Mime: f.Mime, Size: f.Size, SHA256: f.SHA256,
			Offset: p.Offset, DataBase64: base64.StdEncoding.EncodeToString(data[p.Offset:end])}), nil, true
	}
	return nil, nil, false
}

func (g *Gram) list(p herdrapi.GramListParams) (any, *APIError) {
	var filtered []herdrapi.GramMessageInfo
	unread := uint64(0)
	for _, m := range g.msgs {
		isUnread := m.Direction == herdrapi.GramDirectionAgentToOwner && !m.ReadByOwner
		if p.UnreadOnly && !isUnread {
			continue
		}
		if p.OnlyQueue && (m.Direction != herdrapi.GramDirectionOwnerToAgent || m.To != nil || m.GrabbedBy != nil) {
			continue
		}
		if isUnread {
			unread++
		}
		filtered = append(filtered, m)
	}
	slices.Reverse(filtered)
	if filtered == nil {
		filtered = []herdrapi.GramMessageInfo{}
	}
	digest := gramDigest(g.storeID, filtered)
	if p.BeforeID == nil && p.IfUnchangedDigest != nil && *p.IfUnchangedDigest == digest {
		return gramResult(herdrapi.ResponseResultGramListUnchanged{StoreID: g.storeID, Digest: digest}), nil
	}
	msgs := filtered
	if p.BeforeID != nil {
		i := slices.IndexFunc(msgs, func(m herdrapi.GramMessageInfo) bool { return m.ID == *p.BeforeID })
		if i < 0 {
			return nil, gramErr("invalid_params", "before_id is not in this list")
		}
		msgs = msgs[i+1:]
	}
	hasMore := false
	if p.Limit != nil {
		if *p.Limit == 0 {
			return nil, gramErr("invalid_params", "limit must be at least 1")
		}
		limit := min(int(*p.Limit), GramListMaxLimit)
		hasMore = len(msgs) > limit
		msgs = msgs[:min(limit, len(msgs))]
	}
	return gramResult(herdrapi.ResponseResultGramList{Messages: slices.Clone(msgs), StoreID: g.storeID, Digest: digest,
		HasMore: hasMore, UnreadCount: unread}), nil
}

// gramDigest is herdr's list_digest: sha256 over the store id, a NUL and
// the serialized list.
func gramDigest(storeID string, msgs []herdrapi.GramMessageInfo) string {
	h := sha256.New()
	h.Write([]byte(storeID))
	h.Write([]byte{0})
	b, _ := json.Marshal(msgs)
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

// appendChunk stages one piece of an upload. g.mu must be held.
func (g *Gram) appendChunk(id string, off uint64, b64 string) *APIError {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return gramErr("invalid_params", "data_base64 is not valid base64")
	}
	if uint64(len(g.uploads[id])) != off {
		return gramErr("invalid_params", fmt.Sprintf("offset %d, have %d bytes", off, len(g.uploads[id])))
	}
	if len(g.uploads[id])+len(data) > GramMaxFileBytes {
		return gramErr("invalid_params", "file exceeds the 100 MiB limit")
	}
	g.uploads[id] = append(g.uploads[id], data...)
	return nil
}

// Duplex answers gram.upload.stream on `remote-api-bridge`: an ok
// acknowledgement, then one reply per chunk frame until the client closes.
// Any other method is refused as herdr refuses an unknown variant.
func (g *Gram) Duplex(_ context.Context, id, method string, params json.RawMessage, read func() ([]byte, error), emit func([]byte) error) {
	reply := func(v any) error {
		b, _ := json.Marshal(v)
		return emit(b)
	}
	if method != "gram.upload.stream" {
		_ = reply(map[string]any{"id": id, "error": gramErr("invalid_request", "unknown variant `"+method+"`")})
		return
	}
	var p herdrapi.GramUploadStreamParams
	_ = json.Unmarshal(params, &p)
	g.mu.Lock()
	g.calls = append(g.calls, GramCall{method, params})
	g.mu.Unlock()
	if reply(map[string]any{"id": id, "result": gramResult(herdrapi.ResponseResultOk{})}) != nil {
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
		g.mu.Lock()
		e := g.appendChunk(p.UploadID, f.Offset, f.DataBase64)
		g.mu.Unlock()
		if e != nil {
			_ = reply(herdrapi.GramUploadFrameReply{Seq: f.Seq, Error: &herdrapi.ErrorBody{Code: e.Code, Message: e.Message}})
			return
		}
		if reply(herdrapi.GramUploadFrameReply{Seq: f.Seq, Ok: true}) != nil {
			return
		}
	}
}

// GramFixture is one seeded message: herdr's GramMessageInfo plus, for
// its file, the bytes, and an age so a fixture reads as recent.
type GramFixture struct {
	herdrapi.GramMessageInfo
	// AgoSeconds, when set, places the message that long before now.
	AgoSeconds int64 `json:"ago_seconds,omitempty"`
	// FileBase64 is the file's bytes; FileText is a text file's.
	FileBase64 string `json:"file_base64,omitempty"`
	FileText   string `json:"file_text,omitempty"`
}

// Seed adds fixtures in order, oldest first.
func (g *Gram) Seed(fixtures []GramFixture, now time.Time) error {
	for _, f := range fixtures {
		m := f.GramMessageInfo
		if f.AgoSeconds != 0 {
			m.CreatedUnixMs = uint64(now.Add(-time.Duration(f.AgoSeconds) * time.Second).UnixMilli())
		}
		var data []byte
		switch {
		case f.FileBase64 != "":
			b, err := base64.StdEncoding.DecodeString(f.FileBase64)
			if err != nil {
				return fmt.Errorf("fixture %s: %w", m.ID, err)
			}
			data = b
		case f.FileText != "":
			data = []byte(f.FileText)
		}
		g.Add(m, data)
	}
	return nil
}
