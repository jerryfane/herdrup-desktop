package herdrapi

import (
	"encoding/json"
	"fmt"
)

// The streaming methods' open params and frames are not in herdr's schema
// (`#[schemars(skip)]`), so they are typed here by hand from herdr at the
// pinned commit. Only their acknowledgements are generated
// (ResponseResultStreamStarted, ResponseResultOk).

// PaneStreamParams opens `pane.stream`, the server-to-client raw PTY byte
// stream (herdr src/api/schema/panes.rs:456-485).
type PaneStreamParams struct {
	PaneID string `json:"pane_id"`
	// IncludeHistory says whether `reset` keyframes carry ScrollbackLines of
	// history. nil means herdr's default, true (panes.rs:447-462).
	IncludeHistory *bool `json:"include_history,omitempty"`
	// ResumeFrom is an absolute byte offset; herdr carries it for a later
	// gap-free resume and always sends a fresh reset today (panes.rs:463-466).
	ResumeFrom *uint64 `json:"resume_from,omitempty"`
	// Epoch is the runtime epoch the client last saw (panes.rs:467-469).
	Epoch *uint64 `json:"epoch,omitempty"`
	// MaxFrameBytes caps decoded bytes per `data` frame; nil lets the server
	// choose (panes.rs:470-473).
	MaxFrameBytes *uint64 `json:"max_frame_bytes,omitempty"`
	// ScrollbackLines is how many normal-screen rows, at most 1000, every
	// `reset` keyframe carries in HistoryB64; nil or 0 sends screen-only
	// keyframes (panes.rs:474-478).
	ScrollbackLines *uint64 `json:"scrollback_lines,omitempty"`
	// ViewerID identifies this viewer so its `pane.set_pty_size` width lease
	// is dropped when the stream closes (panes.rs:479-484).
	ViewerID *string `json:"viewer_id,omitempty"`
}

// PaneStreamTag is the "stream" field of every pane.stream frame
// (herdr src/api/server/pane_output_stream.rs:35).
const PaneStreamTag = "pane.bytes"

// PaneStreamFrameKind is a pane.stream frame's "frame" field
// (pane_output_stream.rs:99-135).
type PaneStreamFrameKind string

const (
	// PaneStreamFrameReset is a full-screen keyframe: Cols, Rows, DataB64,
	// and HistoryB64/HistoryCursor when scrollback was asked for. Lagged is
	// set when it replaces bytes the client fell behind on.
	PaneStreamFrameReset PaneStreamFrameKind = "reset"
	// PaneStreamFrameData carries the next DataB64 bytes.
	PaneStreamFrameData PaneStreamFrameKind = "data"
	// PaneStreamFrameResize carries the new Cols and Rows.
	PaneStreamFrameResize PaneStreamFrameKind = "resize"
	// PaneStreamFramePing is the idle heartbeat, every 20 s
	// (pane_output_stream.rs:33).
	PaneStreamFramePing PaneStreamFrameKind = "ping"
	// PaneStreamFrameExited is the last frame: the pane's runtime is gone.
	PaneStreamFrameExited PaneStreamFrameKind = "exited"
)

// PaneStreamFrame is one line on a pane.stream after its stream_started
// acknowledgement (StreamFrameLine, pane_output_stream.rs:57-81). A line
// may instead be an ErrorResponse (a guest paused or revoked mid-stream);
// see DecodePaneStreamLine.
type PaneStreamFrame struct {
	Stream string              `json:"stream"`
	Frame  PaneStreamFrameKind `json:"frame"`
	// Seq is an absolute byte offset into the pane's output.
	Seq uint64 `json:"seq"`
	// Epoch identifies the pane runtime's generation.
	Epoch   uint64  `json:"epoch"`
	Cols    *uint16 `json:"cols,omitempty"`
	Rows    *uint16 `json:"rows,omitempty"`
	DataB64 *string `json:"data_b64,omitempty"`
	Lagged  bool    `json:"lagged,omitempty"`
	// HistoryB64 is base64 ANSI scrollback above a reset keyframe's screen,
	// oldest first; empty when the pane has no history to give.
	HistoryB64 *string `json:"history_b64,omitempty"`
	// HistoryCursor is the pane.history cursor for the first row of
	// HistoryB64, present only when older rows remain (capability
	// pane_history).
	HistoryCursor *string `json:"history_cursor,omitempty"`
}

// DecodePaneStreamLine decodes one line after the acknowledgement: a frame,
// or the error envelope herdr writes when it ends the stream.
func DecodePaneStreamLine(line []byte) (*PaneStreamFrame, *ErrorResponse, error) {
	var probe struct {
		Error  json.RawMessage `json:"error"`
		Stream string          `json:"stream"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return nil, nil, err
	}
	if probe.Error != nil {
		var e ErrorResponse
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, nil, err
		}
		return nil, &e, nil
	}
	if probe.Stream != PaneStreamTag {
		return nil, nil, fmt.Errorf("pane.stream line has stream %q, want %q", probe.Stream, PaneStreamTag)
	}
	var f PaneStreamFrame
	if err := json.Unmarshal(line, &f); err != nil {
		return nil, nil, err
	}
	return &f, nil, nil
}

// GramUploadStreamParams opens `gram.upload.stream`, one connection that
// takes a whole file's chunks (herdr src/api/schema/gram.rs:203-214). It is
// acknowledged with ResponseResultOk.
type GramUploadStreamParams struct {
	UploadID string `json:"upload_id"`
}

// GramUploadFrame is one chunk the client writes on a gram.upload.stream
// (UploadFrame, herdr src/api/server/gram_upload_stream.rs:118-126).
type GramUploadFrame struct {
	Seq        uint64 `json:"seq"`
	Offset     uint64 `json:"offset"`
	DataBase64 string `json:"data_base64"`
}

// GramUploadFrameReply is herdr's answer to one GramUploadFrame: Ok, or
// Error, after which herdr closes the stream (UploadAck and
// UploadFrameError, gram_upload_stream.rs:128-140, 316-322).
type GramUploadFrameReply struct {
	Seq   uint64     `json:"seq"`
	Ok    bool       `json:"ok,omitempty"`
	Error *ErrorBody `json:"error,omitempty"`
}
