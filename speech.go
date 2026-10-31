package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/egoist/mygo"
)

type DictationEvent struct {
	Token string   `json:"token"`
	State string   `json:"state"`
	Text  *string  `json:"text,omitempty"`
	Level *float64 `json:"level,omitempty"`
	Error string   `json:"error,omitempty"`
}

var DictationChanged = mygo.NewEvent[DictationEvent]("dictation:changed")

type dictationSession struct {
	token   string
	cancel  context.CancelFunc
	control io.WriteCloser
	done    chan struct{}
}

// Dictation runs one bundled, offline-only microphone recognizer. It has no
// provider selection, URL, API key, network client or cloud fallback.
type Dictation struct {
	mu     sync.Mutex
	active *dictationSession
}

func (d *Dictation) Start(token, locale string) error {
	if token == "" || len(token) > 128 {
		return errors.New("invalid dictation identity")
	}
	resources, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return err
	}
	executable := "herdrup-speech"
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.active != nil {
		return errors.New("dictation is already active")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, filepath.Join(resources, executable), filepath.Join(resources, "ggml-tiny.bin"), locale)
	// The helper's stderr is model diagnostics; all actionable errors arrive as
	// structured events. Never retain audio or recognized text in a diagnostic log.
	cmd.Stderr = io.Discard
	output, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return err
	}
	control, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		control.Close()
		return fmt.Errorf("on-device dictation could not start; reinstall Herdrup to restore its speech engine: %w", err)
	}
	session := &dictationSession{token: token, cancel: cancel, control: control, done: make(chan struct{})}
	d.active = session
	go d.listen(ctx, session, cmd, output)
	return nil
}

func (d *Dictation) listen(ctx context.Context, session *dictationSession, cmd *exec.Cmd, output io.Reader) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	reportedError := false
	for scanner.Scan() {
		var event DictationEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			DictationChanged.Broadcast(DictationEvent{Token: session.token, State: "error", Error: "The offline speech engine returned an invalid response."})
			reportedError = true
			session.cancel()
			break
		}
		if ctx.Err() != nil {
			break
		}
		event.Token = session.token
		DictationChanged.Broadcast(event)
		if event.State == "error" {
			reportedError = true
			session.cancel()
			break
		}
	}
	scanErr := scanner.Err()
	err := cmd.Wait()
	session.control.Close()
	if ctx.Err() == nil && !reportedError && (err != nil || scanErr != nil) {
		DictationChanged.Broadcast(DictationEvent{Token: session.token, State: "error", Error: "On-device dictation stopped unexpectedly. Tap the microphone to try again."})
	}
	session.cancel()
	d.mu.Lock()
	if d.active == session {
		d.active = nil
	}
	d.mu.Unlock()
	close(session.done)
	DictationChanged.Broadcast(DictationEvent{Token: session.token, State: "stopped"})
}

// Stop preserves the last partial result, matching SpeechDictator.stop. Killing
// inference releases capture immediately; no late result can overwrite typed text.
func (d *Dictation) Stop(token string) {
	d.mu.Lock()
	session := d.active
	if session == nil || session.token != token {
		d.mu.Unlock()
		return
	}
	session.cancel()
	session.control.Close()
	d.mu.Unlock()
	<-session.done
}

func (d *Dictation) stopAll() {
	d.mu.Lock()
	session := d.active
	d.mu.Unlock()
	if session != nil {
		d.Stop(session.token)
	}
}
