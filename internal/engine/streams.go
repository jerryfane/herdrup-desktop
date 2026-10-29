package engine

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// PaneStream is one open pane.stream: the stream_started acknowledgement,
// then PTY frames from Next.
type PaneStream struct {
	Started herdrapi.ResponseResultStreamStarted
	s       Stream
}

// PaneStream opens pane.stream for p.PaneID. It returns once herdr has
// acknowledged it; the stream closes when ctx ends or Close is called.
func (c *Client) PaneStream(ctx context.Context, p herdrapi.PaneStreamParams) (*PaneStream, error) {
	m := method("pane.stream")
	if err := c.gate(ctx, m); err != nil {
		return nil, err
	}
	s, err := c.t.OpenStream(ctx, m.Name, p)
	if err != nil {
		return nil, err
	}
	line, err := s.Next()
	if err != nil {
		s.Close()
		if errors.Is(err, io.EOF) {
			err = fmt.Errorf("pane.stream: ended before its acknowledgement")
		}
		return nil, err
	}
	v, err := c.decodeAck(m, line)
	if err != nil {
		s.Close()
		return nil, err
	}
	return &PaneStream{Started: v.(herdrapi.ResponseResultStreamStarted), s: s}, nil
}

// Next returns the next frame. An error envelope herdr writes mid-stream
// (a guest paused or revoked, for example) ends the stream with a
// *StreamError; a clean end is io.EOF.
func (p *PaneStream) Next() (*herdrapi.PaneStreamFrame, error) {
	line, err := p.s.Next()
	if err != nil {
		return nil, err
	}
	f, e, err := herdrapi.DecodePaneStreamLine(line)
	switch {
	case err != nil:
		return nil, fmt.Errorf("pane.stream: %w", err)
	case e != nil:
		p.s.Close()
		return nil, &StreamError{Method: "pane.stream", APIError: &bridge.APIError{Code: e.Error.Code, Message: e.Error.Message}}
	}
	return f, nil
}

// Close ends the stream.
func (p *PaneStream) Close() error { return p.s.Close() }

// Upload chunk sizes, as herdrup sends them (HerdrClient
// gramStreamChunkBytes and gramUploadChunkBytes): a stream frame carries
// herdr's 512 KiB MAX_CHUNK_BYTES; a per-chunk request rides an exec
// argument, which bridge caps at 90 KiB of base64.
const (
	UploadStreamChunkBytes = 512 << 10
	UploadChunkBytes       = 48 << 10
)

// UploadPath is how GramUpload sent a file.
type UploadPath string

const (
	// UploadStream: one gram.upload.stream (capability gram_upload_stream).
	UploadStream UploadPath = "gram.upload.stream"
	// UploadChunked: one gram.upload_chunk per piece.
	UploadChunked UploadPath = "gram.upload_chunk"
)

// GramUpload stages data on herdr and returns the upload_id to attach in
// gram.send or gram.post (herdrup HerdrClient.gramUploadFile); see
// GramUploadFrom.
func (c *Client) GramUpload(ctx context.Context, data []byte) (uploadID string, path UploadPath, err error) {
	return c.GramUploadFrom(ctx, bytes.NewReader(data), int64(len(data)), nil)
}

// GramUploadFrom stages the size bytes of src on herdr, reading them a
// piece at a time, and returns the upload_id. It streams over one
// gram.upload.stream when herdr advertises gram_upload_stream and the
// transport can open a duplex channel, and otherwise sends
// gram.upload_chunk per piece. A stream that fails to open falls back to
// per-chunk under a fresh id, unless herdr rejected the upload itself (any
// error but invalid_request or server_unavailable), which a retry would
// only repeat on a partly written file. progress, when not nil, is told
// the bytes herdr has acknowledged after each piece.
func (c *Client) GramUploadFrom(ctx context.Context, src io.ReaderAt, size int64, progress func(sent int64)) (uploadID string, path UploadPath, err error) {
	if progress == nil {
		progress = func(int64) {}
	}
	uploadID = newUploadID()
	if d, ok := c.t.(Duplexer); ok {
		if supported, _ := c.supports(ctx, herdrapi.CapabilityGramUploadStream); supported {
			err := c.uploadStream(ctx, d, uploadID, src, size, progress)
			if err == nil {
				return uploadID, UploadStream, nil
			}
			var open *uploadOpenError
			if !errors.As(err, &open) || open.fatal() {
				return "", UploadStream, err
			}
			uploadID = newUploadID()
		}
	}
	buf := make([]byte, min(int64(UploadChunkBytes), size))
	err = eachPiece(src, size, buf, func(off int64, piece []byte) error {
		if err := c.GramUploadChunk(ctx, herdrapi.GramUploadChunkParams{
			UploadID: uploadID, Offset: uint64(off), DataBase64: base64.StdEncoding.EncodeToString(piece),
		}); err != nil {
			return err
		}
		progress(off + int64(len(piece)))
		return nil
	})
	if err != nil {
		return "", UploadChunked, err
	}
	return uploadID, UploadChunked, nil
}

// eachPiece reads src in pieces of len(buf) bytes and hands each to send
// with its offset; an empty src is one empty piece, as herdr needs one
// chunk to create the upload.
func eachPiece(src io.ReaderAt, size int64, buf []byte, send func(off int64, piece []byte) error) error {
	for off := int64(0); off == 0 || off < size; {
		n := min(int64(len(buf)), size-off)
		piece := buf[:n]
		// ReadAt may report io.EOF along with a piece that ends the source.
		if got, err := src.ReadAt(piece, off); err != nil && !(errors.Is(err, io.EOF) && got == len(piece)) {
			return fmt.Errorf("read upload at %d: %w", off, err)
		}
		if err := send(off, piece); err != nil {
			return err
		}
		off += n
		if off >= size {
			return nil
		}
	}
	return nil
}

// newUploadID is a fresh upload_id: herdr keys its staging file and
// single-writer claim on it and takes it as one safe path component.
func newUploadID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "desk-" + hex.EncodeToString(b[:])
}

// uploadOpenError is a gram.upload.stream that failed before any frame was
// written, so the per-chunk path may still be tried.
type uploadOpenError struct{ err error }

func (e *uploadOpenError) Error() string { return "gram.upload.stream: " + e.err.Error() }
func (e *uploadOpenError) Unwrap() error { return e.err }

// fatal reports whether herdr rejected the upload rather than the stream
// (herdrup fatalStreamOpenError).
func (e *uploadOpenError) fatal() bool {
	var api *bridge.APIError
	if !errors.As(e.err, &api) {
		return false
	}
	return !slices.Contains([]string{"invalid_request", "server_unavailable"}, api.Code)
}

func (c *Client) uploadStream(ctx context.Context, dx Duplexer, uploadID string, src io.ReaderAt, size int64, progress func(int64)) error {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	d, err := dx.OpenDuplex(sctx)
	if err != nil {
		return &uploadOpenError{err}
	}
	defer d.Close()
	m := method("gram.upload.stream")
	open, err := json.Marshal(struct {
		ID     string                          `json:"id"`
		Method string                          `json:"method"`
		Params herdrapi.GramUploadStreamParams `json:"params"`
	}{"herdrup:gram.upload.stream:" + uploadID, m.Name, herdrapi.GramUploadStreamParams{UploadID: uploadID}})
	if err != nil {
		return err
	}
	if err := d.WriteLine(open); err != nil {
		return &uploadOpenError{err}
	}
	line, err := d.Next()
	if err != nil {
		return &uploadOpenError{err}
	}
	if _, err := c.decodeAck(m, line); err != nil {
		// No frame was written: herdr refused the stream, did not know it
		// (*ErrUnsupported), or answered something else.
		return &uploadOpenError{err}
	}
	var seq uint64
	buf := make([]byte, min(int64(UploadStreamChunkBytes), size))
	err = eachPiece(src, size, buf, func(off int64, piece []byte) error {
		seq++
		frame, _ := json.Marshal(herdrapi.GramUploadFrame{
			Seq: seq, Offset: uint64(off), DataBase64: base64.StdEncoding.EncodeToString(piece),
		})
		if err := d.WriteLine(frame); err != nil {
			return fmt.Errorf("gram.upload.stream: %w", err)
		}
		line, err := d.Next()
		if err != nil {
			return fmt.Errorf("gram.upload.stream: frame %d: %w", seq, err)
		}
		var ack herdrapi.GramUploadFrameReply
		if err := json.Unmarshal(line, &ack); err != nil {
			return fmt.Errorf("gram.upload.stream: frame %d: %w", seq, err)
		}
		if ack.Error != nil {
			return &StreamError{Method: m.Name, APIError: &bridge.APIError{Code: ack.Error.Code, Message: ack.Error.Message}}
		}
		if !ack.Ok || ack.Seq != seq {
			return fmt.Errorf("gram.upload.stream: frame %d acknowledged as %s", seq, line)
		}
		progress(off + int64(len(piece)))
		return nil
	})
	if err != nil {
		return err
	}
	// herdr frees its claim on the upload_id only once it sees end of
	// file, and refuses to attach an upload a stream still holds, so wait
	// for it to close its side.
	if err := d.CloseWrite(); err != nil {
		return fmt.Errorf("gram.upload.stream: %w", err)
	}
	for {
		if _, err := d.Next(); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("gram.upload.stream: close: %w", err)
		}
	}
}
