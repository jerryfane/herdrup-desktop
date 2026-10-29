package engine_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"golang.org/x/crypto/ssh"
)

// herdr is a fake herdr whose ping advertises caps (nil: no capabilities
// field, an older herdr) and which answers handle for everything else.
type herdr struct {
	srv   *fakeherdr.Server
	pings atomic.Int32
	// pingErr, when set, makes ping fail.
	pingErr atomic.Bool
}

func start(t *testing.T, caps map[string]bool, handle func(method string, params json.RawMessage) (any, *fakeherdr.APIError), setup func(*fakeherdr.Server)) (*herdr, *engine.Client) {
	t.Helper()
	h := &herdr{}
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(hostPriv)
	clientPub, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	authorized, _ := ssh.NewPublicKey(clientPub)
	block, _ := ssh.MarshalPrivateKey(clientPriv, "")
	h.srv = &fakeherdr.Server{
		HostKey: hostKey, Authorized: authorized,
		Handle: func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" {
				h.pings.Add(1)
				if h.pingErr.Load() {
					return nil, &fakeherdr.APIError{Code: "server_unavailable", Message: "busy"}
				}
				pong := map[string]any{"type": "pong", "version": "0.9.5", "protocol": 22}
				if caps != nil {
					pong["capabilities"] = caps
				}
				return pong, nil
			}
			if handle != nil {
				return handle(method, params)
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		},
	}
	if setup != nil {
		setup(h.srv)
	}
	addr, err := h.srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.srv.Close() })
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	c, err := bridge.Dial(context.Background(), bridge.Config{
		Host: host, Port: port, User: "dev", KeyPEM: pem.EncodeToMemory(block),
		Pins: bridge.NewFilePinStore(filepath.Join(t.TempDir(), "pins.json")),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return h, engine.New(engine.Bridge(c))
}

func (h *herdr) methods() []string {
	var out []string
	for _, r := range h.srv.Requests() {
		out = append(out, r.Method)
	}
	return out
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return c
}

var groups = map[string]any{"type": "agent_groups", "revision": 3, "folders": []any{}, "stars": []any{"a"}}

func TestKnownMissingCapabilityIsRefusedBeforeSending(t *testing.T) {
	h, c := start(t, map[string]bool{"agent_groups": false}, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
		return groups, nil
	}, nil)
	_, err := c.AgentGroupsGet(ctx(t))
	var unsupported *engine.ErrUnsupported
	if !errors.As(err, &unsupported) {
		t.Fatalf("got %v, want ErrUnsupported", err)
	}
	if unsupported.Method != "agent.groups.get" || unsupported.Capability != herdrapi.CapabilityAgentGroups || unsupported.ServerVersion != "0.9.5" {
		t.Errorf("ErrUnsupported %+v", unsupported)
	}
	if slices.Contains(h.methods(), "agent.groups.get") {
		t.Error("agent.groups.get was sent to a herdr without agent_groups")
	}
}

func TestAdvertisedCapabilityIsCalledAndCached(t *testing.T) {
	h, c := start(t, map[string]bool{"agent_groups": true}, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
		return groups, nil
	}, nil)
	for range 2 {
		g, err := c.AgentGroupsGet(ctx(t))
		if err != nil || g.Revision != 3 || !slices.Equal(g.Stars, []string{"a"}) {
			t.Fatalf("got %+v, %v", g, err)
		}
	}
	if n := h.pings.Load(); n != 1 {
		t.Errorf("pinged %d times, want one probe cached for both calls", n)
	}
}

func TestFailedProbeStaysUnknownAndIsRetried(t *testing.T) {
	h, c := start(t, map[string]bool{"agent_groups": false}, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
		return groups, nil
	}, nil)
	h.pingErr.Store(true)
	// Unknown capability: the call goes through rather than being refused.
	if _, err := c.AgentGroupsGet(ctx(t)); err != nil {
		t.Fatalf("with the probe failing: %v", err)
	}
	h.pingErr.Store(false)
	var unsupported *engine.ErrUnsupported
	if _, err := c.AgentGroupsGet(ctx(t)); !errors.As(err, &unsupported) {
		t.Fatalf("after a probe answered: got %v, want ErrUnsupported", err)
	}
}

func TestOlderHerdrErrorsMapToUnsupported(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  fakeherdr.APIError
		want bool
	}{
		{"unknown_method", fakeherdr.APIError{Code: "unknown_method", Message: "no"}, true},
		{"unknown variant", fakeherdr.APIError{Code: "invalid_request", Message: "unknown variant `machine.status`, expected one of `ping`"}, true},
		{"another variant", fakeherdr.APIError{Code: "invalid_request", Message: "unknown variant `other`"}, false},
		{"plain invalid_request", fakeherdr.APIError{Code: "invalid_request", Message: "missing field"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, c := start(t, map[string]bool{}, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
				return nil, &tc.err
			}, nil)
			_, err := c.MachineStatus(ctx(t))
			var unsupported *engine.ErrUnsupported
			if got := errors.As(err, &unsupported); got != tc.want {
				t.Fatalf("got %v; unsupported=%v, want %v", err, got, tc.want)
			}
			var api *bridge.APIError
			if !tc.want && !errors.As(err, &api) {
				t.Errorf("got %v, want the APIError itself", err)
			}
		})
	}
}

func TestWrongResultTagFails(t *testing.T) {
	_, c := start(t, map[string]bool{}, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		return map[string]any{"type": "pong", "version": "x", "protocol": 22}, nil
	}, nil)
	_, err := c.AgentList(ctx(t), herdrapi.AgentListParams{})
	var tagErr *engine.ResultTagError
	if !errors.As(err, &tagErr) || tagErr.Got != "pong" || !slices.Equal(tagErr.Want, []string{"agent_list"}) {
		t.Fatalf("got %v, want ResultTagError pong vs agent_list", err)
	}
}

func TestGramListTakesEitherTag(t *testing.T) {
	_, c := start(t, map[string]bool{}, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
		return map[string]any{"type": "gram_list_unchanged", "digest": "d", "store_id": "s"}, nil
	}, nil)
	l, err := c.GramList(ctx(t), herdrapi.GramListParams{})
	if err != nil || l.Unchanged == nil || l.Unchanged.Digest != "d" || l.List != nil {
		t.Fatalf("got %+v, %v", l, err)
	}
}

func TestGroupsConflictCarriesTheStoredDocument(t *testing.T) {
	_, c := start(t, map[string]bool{"agent_groups": true}, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		return nil, &fakeherdr.APIError{Code: "groups_conflict", Message: "agent groups changed: revision 7 is stored, not 1",
			Current: map[string]any{"revision": 7, "folders": []any{map[string]any{"id": "f1", "name": "Ops", "order": 0, "members": []string{"t1"}}}, "stars": []string{"s"}}}
	}, nil)
	_, err := c.AgentGroupsSet(ctx(t), herdrapi.AgentGroupsSetParams{Revision: 1, Folders: []herdrapi.AgentGroupFolder{}, Stars: []string{}})
	var conflict *engine.GroupsConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("got %v, want GroupsConflictError", err)
	}
	cur := conflict.Current
	if cur.Revision != 7 || len(cur.Folders) != 1 || cur.Folders[0].Name != "Ops" || !slices.Equal(cur.Folders[0].Members, []string{"t1"}) || !slices.Equal(cur.Stars, []string{"s"}) {
		t.Errorf("current %+v", cur)
	}
}

// events is a scripted events.subscribe: each stream takes the next
// script; a script line "hang" stops writing without closing, "close" ends
// the stream.
type events struct {
	mu      sync.Mutex
	scripts [][]string
	opens   atomic.Int32
	ack     string
}

func (e *events) stream(ctx context.Context, id string, _ json.RawMessage, emit func([]byte) error) {
	e.opens.Add(1)
	ack := e.ack
	if ack == "" {
		ack = `{"type":"subscription_started"}`
	}
	if strings, _ := json.Marshal(id); emit([]byte(`{"id":`+string(strings)+`,"result":`+ack+`}`)) != nil {
		return
	}
	e.mu.Lock()
	var script []string
	if len(e.scripts) > 0 {
		script, e.scripts = e.scripts[0], e.scripts[1:]
	}
	e.mu.Unlock()
	for _, line := range script {
		switch line {
		case "hang":
			<-ctx.Done()
			return
		case "close":
			return
		case "pause":
			time.Sleep(150 * time.Millisecond)
			continue
		}
		if emit([]byte(line)) != nil {
			return
		}
	}
	<-ctx.Done()
}

func subscribeHerdr(t *testing.T, ev *events) (*herdr, *engine.Client, *atomic.Int32) {
	lists := &atomic.Int32{}
	h, c := start(t, map[string]bool{"events_v2": true}, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		if method == "agent.list" {
			lists.Add(1)
			return map[string]any{"type": "agent_list", "agents": []any{}}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}, func(s *fakeherdr.Server) {
		s.Streams = map[string]fakeherdr.StreamFunc{"events.subscribe": ev.stream}
	})
	return h, c, lists
}

// collect runs Subscribe until stop says so, and returns its events.
func collect(t *testing.T, c *engine.Client, opts engine.SubscribeOptions, stop func([]engine.Event) bool) ([]engine.Event, error) {
	t.Helper()
	cx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var got []engine.Event
	err := c.Subscribe(cx, opts, func(e engine.Event) {
		got = append(got, e)
		if stop(got) {
			cancel()
		}
	})
	if cx.Err() == context.DeadlineExceeded {
		t.Fatalf("Subscribe never reached the expected events: %v", kinds(got))
	}
	return got, err
}

func kinds(evs []engine.Event) []engine.EventKind {
	var out []engine.EventKind
	for _, e := range evs {
		out = append(out, e.Kind)
	}
	return out
}

func count(evs []engine.Event, k engine.EventKind) int {
	n := 0
	for _, e := range evs {
		if e.Kind == k {
			n++
		}
	}
	return n
}

func TestSubscribeLagRelists(t *testing.T) {
	ev := &events{scripts: [][]string{{
		`{"seq":1,"event":"pane.agent_status_changed","data":{"pane_id":"p1","agent_status":"blocked"}}`,
		`{"control":"heartbeat","seq":1}`,
		`{"control":"lagged","seq":904,"first_missed_seq":2,"last_missed_seq":903}`,
	}}}
	_, c, lists := subscribeHerdr(t, ev)
	got, _ := collect(t, c, engine.SubscribeOptions{}, func(e []engine.Event) bool { return count(e, engine.EventListed) == 2 })
	want := []engine.EventKind{engine.EventStarted, engine.EventListed, engine.EventLine, engine.EventHeartbeat, engine.EventLagged, engine.EventListed}
	if !slices.Equal(kinds(got), want) {
		t.Fatalf("events %v, want %v", kinds(got), want)
	}
	if l := got[4].Lagged; l.FirstMissedSeq != 2 || l.LastMissedSeq != 903 {
		t.Errorf("lagged %+v", l)
	}
	if got[2].Line.Seq != 1 || got[2].Line.Event != "pane.agent_status_changed" {
		t.Errorf("event line %+v", got[2].Line)
	}
	if n := lists.Load(); n != 2 {
		t.Errorf("listed %d times, want after the ack and after the lag", n)
	}
}

func TestSubscribeReconnectsWhenSilentAndRelists(t *testing.T) {
	ev := &events{scripts: [][]string{{"hang"}, {}}}
	_, c, lists := subscribeHerdr(t, ev)
	got, _ := collect(t, c, engine.SubscribeOptions{
		Silence: 200 * time.Millisecond,
		Backoff: engine.Backoff{Initial: 10 * time.Millisecond},
	}, func(e []engine.Event) bool { return count(e, engine.EventListed) == 2 })
	want := []engine.EventKind{engine.EventStarted, engine.EventListed, engine.EventReconnecting, engine.EventStarted, engine.EventListed}
	if !slices.Equal(kinds(got), want) {
		t.Fatalf("events %v, want %v", kinds(got), want)
	}
	if !errors.Is(got[2].Err, engine.ErrSilent) {
		t.Errorf("reconnect reason %v, want ErrSilent", got[2].Err)
	}
	if ev.opens.Load() != 2 || lists.Load() != 2 {
		t.Errorf("opens=%d lists=%d, want 2 and 2", ev.opens.Load(), lists.Load())
	}
}

func TestHeartbeatsKeepTheStreamOpen(t *testing.T) {
	// Six heartbeats 150 ms apart span 900 ms, well past the 400 ms
	// silence window, which each one restarts.
	var script []string
	for i := range 6 {
		script = append(script, "pause", `{"control":"heartbeat","seq":`+strconv.Itoa(i)+`}`)
	}
	ev := &events{scripts: [][]string{script}}
	_, c, _ := subscribeHerdr(t, ev)
	got, _ := collect(t, c, engine.SubscribeOptions{Silence: 400 * time.Millisecond, NoList: true},
		func(e []engine.Event) bool { return count(e, engine.EventHeartbeat) == 6 })
	if count(got, engine.EventReconnecting) != 0 {
		t.Errorf("reconnected on a stream sending heartbeats: %v", kinds(got))
	}
}

func TestReconnectBackoffDoublesAndResetsAfterALine(t *testing.T) {
	// Three streams that end at once after the ack, then one that delivers
	// a line and ends: the delay doubles, then starts over.
	ev := &events{scripts: [][]string{{"close"}, {"close"}, {"close"}, {`{"control":"heartbeat","seq":1}`, "close"}, {"close"}}}
	_, c, _ := subscribeHerdr(t, ev)
	got, _ := collect(t, c, engine.SubscribeOptions{
		NoList:  true,
		Backoff: engine.Backoff{Initial: 10 * time.Millisecond, Max: 30 * time.Millisecond, JitterMin: 1, JitterMax: 1},
	}, func(e []engine.Event) bool { return count(e, engine.EventReconnecting) == 5 })
	var delays []time.Duration
	for _, e := range got {
		if e.Kind == engine.EventReconnecting {
			delays = append(delays, e.Delay)
		}
	}
	ms := time.Millisecond
	if want := []time.Duration{10 * ms, 20 * ms, 30 * ms, 10 * ms, 20 * ms}; !slices.Equal(delays, want) {
		t.Fatalf("delays %v, want %v", delays, want)
	}
}

func TestBackoffJitter(t *testing.T) {
	b := engine.Backoff{Initial: 100 * time.Millisecond, Max: time.Second, Rand: func() float64 { return 0.5 }}
	if d := b.Next(); d != 80*time.Millisecond {
		t.Errorf("first delay %v, want 100ms scaled by 0.8 (0.6..1.0 at 0.5)", d)
	}
}

func TestSubscribeRefusedIsFatal(t *testing.T) {
	ev := &events{}
	_, c := start(t, map[string]bool{"events_v2": true}, nil, func(s *fakeherdr.Server) {
		s.Streams = map[string]fakeherdr.StreamFunc{"events.subscribe": func(_ context.Context, id string, _ json.RawMessage, emit func([]byte) error) {
			ev.opens.Add(1)
			_ = emit([]byte(`{"id":"` + id + `","error":{"code":"invalid_params","message":"bad subscription"}}`))
		}}
	})
	err := c.Subscribe(ctx(t), engine.SubscribeOptions{NoList: true}, func(engine.Event) {})
	var api *bridge.APIError
	if !errors.As(err, &api) || api.Code != "invalid_params" || ev.opens.Load() != 1 {
		t.Fatalf("got %v after %d opens, want the refusal at once", err, ev.opens.Load())
	}
}

func paneStreamHerdr(t *testing.T, lines ...string) *engine.Client {
	_, c := start(t, map[string]bool{}, nil, func(s *fakeherdr.Server) {
		s.Streams = map[string]fakeherdr.StreamFunc{"pane.stream": func(ctx context.Context, id string, _ json.RawMessage, emit func([]byte) error) {
			for _, l := range lines {
				if emit([]byte(l)) != nil {
					return
				}
			}
			<-ctx.Done()
		}}
	})
	return c
}

func TestPaneStreamFramesThenErrorEnvelopeEndsIt(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("hi"))
	c := paneStreamHerdr(t,
		`{"id":"x","result":{"type":"stream_started","pane_id":"p1","epoch":2,"cols":80,"rows":24,"base_seq":0,"resync":false}}`,
		`{"stream":"pane.bytes","frame":"reset","seq":0,"epoch":2,"cols":80,"rows":24,"data_b64":"`+data+`"}`,
		`{"stream":"pane.bytes","frame":"ping","seq":2,"epoch":2}`,
		`{"id":"x","error":{"code":"guest_paused","message":"the owner paused sharing"}}`,
		`{"stream":"pane.bytes","frame":"data","seq":2,"epoch":2,"data_b64":"`+data+`"}`,
	)
	ps, err := c.PaneStream(ctx(t), herdrapi.PaneStreamParams{PaneID: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	if ps.Started.PaneID != "p1" || ps.Started.Cols != 80 {
		t.Errorf("started %+v", ps.Started)
	}
	var frames []herdrapi.PaneStreamFrameKind
	for {
		f, err := ps.Next()
		if err != nil {
			var se *engine.StreamError
			if !errors.As(err, &se) || se.Code != "guest_paused" {
				t.Fatalf("ended with %v, want StreamError guest_paused", err)
			}
			break
		}
		frames = append(frames, f.Frame)
	}
	if !slices.Equal(frames, []herdrapi.PaneStreamFrameKind{herdrapi.PaneStreamFrameReset, herdrapi.PaneStreamFramePing}) {
		t.Errorf("frames %v before the error", frames)
	}
}

func TestPaneStreamRefusedAtOpen(t *testing.T) {
	c := paneStreamHerdr(t, `{"id":"x","error":{"code":"pane_not_found","message":"no pane"}}`)
	_, err := c.PaneStream(ctx(t), herdrapi.PaneStreamParams{PaneID: "p9"})
	var api *bridge.APIError
	if !errors.As(err, &api) || api.Code != "pane_not_found" {
		t.Fatalf("got %v, want pane_not_found", err)
	}
}

// uploads is a fake herdr's staging: upload_id -> bytes, and which path
// wrote them.
type uploads struct {
	mu      sync.Mutex
	files   map[string][]byte
	streams int
	chunks  int
}

func (u *uploads) put(id string, off uint64, b64 string) *fakeherdr.APIError {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return &fakeherdr.APIError{Code: "invalid_params", Message: err.Error()}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.files == nil {
		u.files = map[string][]byte{}
	}
	if uint64(len(u.files[id])) != off {
		return &fakeherdr.APIError{Code: "invalid_params", Message: "offset"}
	}
	u.files[id] = append(u.files[id], data...)
	return nil
}

func uploadHerdr(t *testing.T, streamCap bool, openErr *fakeherdr.APIError) (*uploads, *engine.Client) {
	u := &uploads{}
	_, c := start(t, map[string]bool{"gram_upload_stream": streamCap}, func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		if method != "gram.upload_chunk" {
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		}
		var p herdrapi.GramUploadChunkParams
		_ = json.Unmarshal(params, &p)
		u.mu.Lock()
		u.chunks++
		u.mu.Unlock()
		if err := u.put(p.UploadID, p.Offset, p.DataBase64); err != nil {
			return nil, err
		}
		return map[string]any{"type": "ok"}, nil
	}, func(s *fakeherdr.Server) {
		s.Duplex = func(_ context.Context, id, method string, params json.RawMessage, read func() ([]byte, error), emit func([]byte) error) {
			if method != "gram.upload.stream" {
				return
			}
			u.mu.Lock()
			u.streams++
			u.mu.Unlock()
			idJSON, _ := json.Marshal(id)
			if openErr != nil {
				e, _ := json.Marshal(openErr)
				_ = emit([]byte(`{"id":` + string(idJSON) + `,"error":` + string(e) + `}`))
				return
			}
			var p herdrapi.GramUploadStreamParams
			_ = json.Unmarshal(params, &p)
			_ = emit([]byte(`{"id":` + string(idJSON) + `,"result":{"type":"ok"}}`))
			for {
				line, err := read()
				if err != nil {
					return // client EOF: release the claim and close
				}
				var f herdrapi.GramUploadFrame
				_ = json.Unmarshal(line, &f)
				reply := herdrapi.GramUploadFrameReply{Seq: f.Seq, Ok: true}
				if e := u.put(p.UploadID, f.Offset, f.DataBase64); e != nil {
					reply = herdrapi.GramUploadFrameReply{Seq: f.Seq, Error: &herdrapi.ErrorBody{Code: e.Code, Message: e.Message}}
				}
				b, _ := json.Marshal(reply)
				if emit(b) != nil || reply.Error != nil {
					return
				}
			}
		}
	})
	return u, c
}

func payload(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}

func TestUploadPathSelection(t *testing.T) {
	data := payload(engine.UploadStreamChunkBytes + 1000)
	for _, tc := range []struct {
		name        string
		streamCap   bool
		openErr     *fakeherdr.APIError
		wantPath    engine.UploadPath
		wantStreams int
		wantErr     bool
	}{
		{"stream when advertised", true, nil, engine.UploadStream, 1, false},
		{"chunks without the capability", false, nil, engine.UploadChunked, 0, false},
		{"chunks when the stream is refused as unknown", true, &fakeherdr.APIError{Code: "invalid_request", Message: "unknown variant `gram.upload.stream`"}, engine.UploadChunked, 1, false},
		{"a rejected upload is not retried", true, &fakeherdr.APIError{Code: "gram_unavailable", Message: "no gram"}, engine.UploadStream, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u, c := uploadHerdr(t, tc.streamCap, tc.openErr)
			id, path, err := c.GramUpload(ctx(t), data)
			if (err != nil) != tc.wantErr || path != tc.wantPath {
				t.Fatalf("got path %q, err %v; want %q, err=%v", path, err, tc.wantPath, tc.wantErr)
			}
			u.mu.Lock()
			defer u.mu.Unlock()
			if u.streams != tc.wantStreams {
				t.Errorf("%d upload streams, want %d", u.streams, tc.wantStreams)
			}
			if tc.wantErr {
				if u.chunks != 0 {
					t.Errorf("fell back to %d chunks after herdr rejected the upload", u.chunks)
				}
				return
			}
			if string(u.files[id]) != string(data) {
				t.Errorf("staged %d bytes under %s, want the %d sent", len(u.files[id]), id, len(data))
			}
			wantChunks := 0
			if path == engine.UploadChunked {
				wantChunks = (len(data) + engine.UploadChunkBytes - 1) / engine.UploadChunkBytes
			}
			if u.chunks != wantChunks {
				t.Errorf("%d gram.upload_chunk calls, want %d", u.chunks, wantChunks)
			}
		})
	}
}

// shortReader is a file that turned out shorter than its size.
type shortReader struct{ data []byte }

func (r shortReader) ReadAt(p []byte, off int64) (int, error) {
	if off >= int64(len(r.data)) {
		return 0, errors.New("short file")
	}
	return copy(p, r.data[off:]), nil
}

func TestUploadFromReportsAcknowledgedBytes(t *testing.T) {
	for _, streamCap := range []bool{true, false} {
		piece := engine.UploadChunkBytes
		if streamCap {
			piece = engine.UploadStreamChunkBytes
		}
		data := payload(2*piece + 100)
		u, c := uploadHerdr(t, streamCap, nil)
		var sent []int64
		id, _, err := c.GramUploadFrom(ctx(t), bytes.NewReader(data), int64(len(data)), func(n int64) { sent = append(sent, n) })
		if err != nil {
			t.Fatal(err)
		}
		want := []int64{int64(piece), int64(2 * piece), int64(len(data))}
		if !slices.Equal(sent, want) {
			t.Errorf("stream %v: progress %v, want %v", streamCap, sent, want)
		}
		u.mu.Lock()
		if !bytes.Equal(u.files[id], data) {
			t.Errorf("stream %v: staged %d bytes, want %d", streamCap, len(u.files[id]), len(data))
		}
		u.mu.Unlock()
	}
}

func TestUploadFromFailsOnAShortRead(t *testing.T) {
	_, c := uploadHerdr(t, false, nil)
	data := payload(engine.UploadChunkBytes + 10)
	if _, _, err := c.GramUploadFrom(ctx(t), shortReader{data[:engine.UploadChunkBytes]}, int64(len(data)), nil); err == nil {
		t.Fatal("a file shorter than its size uploaded")
	}
}

func TestUploadFromSendsAnEmptyFileAsOneChunk(t *testing.T) {
	u, c := uploadHerdr(t, false, nil)
	if _, _, err := c.GramUploadFrom(ctx(t), bytes.NewReader(nil), 0, nil); err != nil {
		t.Fatal(err)
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.chunks != 1 {
		t.Fatalf("%d chunks for an empty file, want 1", u.chunks)
	}
}
