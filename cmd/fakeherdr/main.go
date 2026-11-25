// Command fakeherdr serves a canned herdr over SSH on this machine. CI runs
// it so the window smoke test has a board to show on runners without herdr.
// It is a test tool, not part of the app.
package main

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

//go:embed agents.json
var defaultAgents []byte

// sampleGrams is the Gram inbox -grams sample seeds: agent messages old and
// new, read and unread, with code, an image, a file, an expired file and a
// federated sender, and the owner's posts to an agent and the queue.
//
//go:embed grams.json
var sampleGrams []byte

func main() {
	listen := flag.String("listen", "127.0.0.1:2222", "address to serve SSH on")
	clientKey := flag.String("client-key", "fakeherdr-client.key", "write a new client private key here; only it can log in")
	agentsFile := flag.String("agents", "", "agent.list result JSON (default: built-in sample); served anew, and announced to event streams, whenever the file changes")
	mode := flag.String("mode", "populated", "agent.list behaviour: populated (the agents JSON), empty (no agents) or loading (never answers)")
	uploadStream := flag.Bool("upload-stream", true, "advertise gram_upload_stream and serve gram.upload.stream")
	machinesFile := flag.String("machines", "", "saved SSH machines for machine.status and `herdr machine federate|unfederate`: a JSON array of objects with herdr's machine.status fields (default: none, and no machine subcommand)")
	machineFail := flag.String("machine-fail", "", "make `herdr machine federate|unfederate` exit 1 with this stderr")
	gramsFile := flag.String("grams", "", "seed the Gram store: \"sample\" for the built-in messages (grams.json), or a JSON array of gram messages with optional ago_seconds, file_base64 or file_text (default: empty)")
	ownerAccess := flag.String("owner-access", "", "serve owner_access.* (herdr #491, web owner access) as a machine on this relay URL, e.g. https://guest.herdrup.app")
	interactions := flag.Bool("interactions", false, "serve sample transcript and echo terminal (no live commands or model)")
	askForm := flag.String("ask-form", "", "with -interactions, the pending ask is an omp HTML form (herdr ask-form contract): answerable (ping advertises ask_form), readonly (form_answerable false), moved (agent.answer_form answers ask_form_moved) or old-host (no ask_form capability)")
	askDismiss := flag.Bool("ask-dismiss", false, "with -interactions, the pending ask is dismissable and agent.dismiss_ask cancels it (herdr #484; ping advertises ask_dismiss); with -guest-relay a guest may dismiss where it may answer")
	askDismissRefuse := flag.String("ask-dismiss-refuse", "", "with -ask-dismiss, agent.dismiss_ask answers this herdr error code (not_cancelled, timeout, ask_unsupported) instead of cancelling")
	transcriptOlderPages := flag.Int("transcript-older-pages", 1, "with -interactions, how many older agent.transcript pages sit before the newest one, one owner prompt each")
	transcriptDelay := flag.Duration("transcript-delay", 0, "with -interactions, answer agent.transcript after this delay, as a slow link does")
	transcriptOlderFail := flag.Int("transcript-older-fail", 0, "with -interactions, refuse the first N agent.transcript before pages (older history), as a flaky link does; the page after that answers")
	bracketedWrite := flag.String("bracketed-write", "", "pane.send_bracketed_text (herdr #517): on (served, and ping advertises pane_send_bracketed_text) or paste-off (served, but every pane's program has bracketed paste off, so it answers bracketed_paste_unavailable); it also serves pane.send_text where no other fixture does (-interactions echoes the text); default: refused as by a herdr that predates it")
	streamStall := flag.Int("stream-stall", 0, "with -interactions, end the first N pane.streams after 3 s with herdr's stream_stalled error (herdr #410), as a reader too slow for herdr is")
	streamDelay := flag.Duration("stream-delay", 0, "with -interactions, start pane.stream after this delay, as a slow link does")
	topics := flag.Bool("topics", false, "serve herdr #475 agent topics: agent.topics.*, agent.transcript with topic and agent_topics_changed events (ping advertises agent_topics and agent_transcript_topic); every agent has three sample topics")
	topicSuggestions := flag.Bool("topic-suggestions", false, "with -topics, also serve herdr #489/#490: the Topics switch (agent.topics.set_enabled, topics_enabled on omp agents) and topic suggestions with Organise (ping advertises agent_topics_switch and agent_topic_suggestions); every agent's Inbox suggests one topic")
	topicsOff := flag.String("topics-off", "", "with -topic-suggestions, comma-separated pane ids whose topics start switched off")
	topicsListFail := flag.String("topics-list-fail-file", "", "with -topics, agent.topics.list answers the error code this file holds (topics_unreachable when empty) while it exists")
	topicsPlain := flag.String("topics-no-suggestions", "", "with -topic-suggestions, comma-separated pane ids of omp agents without suggestions (topics_unsupported)")
	topicsTurn := flag.Duration("topics-turn", 2*time.Second, "with -topics, how long a topic's turn runs before its reply")
	transcriptGrow := flag.Duration("transcript-grow", 0, "with -interactions, append an agent turn (prompt, tool step, reply) to the sample transcript at this interval, as a long session grows (0: never)")
	accounts := flag.Bool("accounts", false, "serve isolated account registration and sign-in fixture; accepts native-smoke-code, never runs auth commands")
	guests := flag.Bool("guests", false, "serve isolated shared-access stores and activity; never creates real relay credentials or grants")
	creation := flag.Bool("creation", false, "serve isolated pane and agent creation; never starts a real process or model")
	responsesFile := flag.String("responses", "", "immutable native-reference API response map, including avatar and session replies")
	current := flag.Bool("current", false, "answer as a herdr that needs no update (herdrup ServerRequirement.current): ping also advertises server_update and the features it requires, server.update_check offers nothing newer")
	sessionTransfer := flag.Bool("session-transfer", false, "advertise agent_session_transfer and serve agent.transfer_session: a prepare is ready at once, its confirm completes")
	guestRelay := flag.String("guest-relay", "", "also serve a guest relay and herdr's guest gate on this loopback address (127.0.0.1:0 for any port) and log a one-use invitation for the docs agent, which waits on a menu until a guest's committing key; never a real relay or grant")
	guestOwnerAnswers := flag.Bool("guest-owner-answers", false, "with -guest-relay, answer as a herdr older than guest answers: agent.answer and pane.send_keys are guest_forbidden and pending_ask.answerable is withheld")
	guestConnectLimit := flag.Int("guest-connect-limit", 0, "with -guest-relay, refuse a guest connect with 429 rate_limited once this many arrived in the minute before it, as the relay's GUEST_CONNECT_LIMIT (30) does a network's; 0 is no limit. Every connect is logged either way")
	guestWebOrigin := flag.String("guest-web-origin", "", "with -guest-relay, also accept guest WebSockets from this page origin (host:port, e.g. 127.0.0.1:24753), for the web guest served locally")
	guestPauseFile := flag.String("guest-pause-file", "", "with -guest-relay, pause the share while this file exists (agent.list shows the agent with guest_running false and its methods refuse guest_paused), as herdr does when the agent leaves its pane's foreground; checked every 500 ms")
	guestGram := flag.Bool("guest-gram", false, "with -guest-relay, share Gram with the guest: features.gram is on and the gate serves the guest Gram methods on the fake Gram store")
	guestMultiRequest := flag.Bool("guest-multi-request", false, "with -guest-relay, serve requests in turn on one guest session and advertise features.multi_request, as herdr does since jerryfane/herdr#356; each session's end is logged")
	guestShares := flag.String("guest-shares", "", "with -guest-relay, serve these guest grants instead of the docs one, all on the one relay address: semicolon-separated agent|owner|machine|options, options a comma-separated set of gram (features.gram), multi (features.multi_request) and pages (120 seeded Grams, so gram.list pages); grants with the same owner and machine are one host. Each gets its own invitation, logged as \"invite <agent> <link>\", and its own Gram store seeded with messages whose times interleave across grants. -guest-web-origin applies; the other -guest-* flags do not")
	guestGramInject := flag.String("guest-gram-inject", "", "with -guest-shares, whenever this file appears, append each of its agent|text lines as a new unread message from agent to that grant's Gram, then remove the file; checked every 300 ms")
	flag.Parse()

	agents := defaultAgents
	if *agentsFile != "" {
		var err error
		if agents, err = os.ReadFile(*agentsFile); err != nil {
			log.Fatal(err)
		}
	}
	if !json.Valid(agents) {
		log.Fatal("agents JSON is invalid")
	}
	var machines []fakeherdr.Machine
	if *machinesFile != "" {
		raw, err := os.ReadFile(*machinesFile)
		if err != nil {
			log.Fatal(err)
		}
		machines = []fakeherdr.Machine{}
		if err := json.Unmarshal(raw, &machines); err != nil {
			log.Fatalf("machines JSON: %v", err)
		}
	}
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	hostKey, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		log.Fatal(err)
	}
	clientPub, clientPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(clientPriv, "fakeherdr")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*clientKey, pem.EncodeToMemory(block), 0o600); err != nil {
		log.Fatal(err)
	}
	authorized, err := ssh.NewPublicKey(clientPub)
	if err != nil {
		log.Fatal(err)
	}

	w := newWrites()
	w.uploadStream = *uploadStream
	if *gramsFile != "" {
		raw := sampleGrams
		if *gramsFile != "sample" {
			if raw, err = os.ReadFile(*gramsFile); err != nil {
				log.Fatal(err)
			}
		}
		var fixtures []fakeherdr.GramFixture
		if err := json.Unmarshal(raw, &fixtures); err != nil {
			log.Fatalf("grams JSON: %v", err)
		}
		if err := w.gram.Seed(fixtures, time.Now()); err != nil {
			log.Fatal(err)
		}
	}
	set := newAgentSet(agents)
	w.actions = fakeherdr.NewAgentActions(set.get, set.set, *sessionTransfer)
	handle, err := handler(*mode, set.get, w)
	if err != nil {
		log.Fatal(err)
	}
	s := &fakeherdr.Server{
		HostKey:       hostKey,
		Authorized:    authorized,
		Handle:        handle,
		Events:        set.events,
		Duplex:        w.gram.Duplex,
		Machines:      machines,
		MachineStderr: *machineFail,
	}
	var grow *fakeherdr.Interaction
	if *interactions {
		x := fakeherdr.NewInteraction()
		x.SetAskForm(*askForm)
		x.OlderPages = *transcriptOlderPages
		x.Dismissable = *askDismiss
		if *askDismissRefuse != "" {
			x.DismissRefusal = &fakeherdr.APIError{Code: *askDismissRefuse, Message: "omp did not report the ask cancelled"}
		}
		grow = x
		var stall, olderFails atomic.Int64
		s.Streams = map[string]fakeherdr.StreamFunc{"pane.stream": func(ctx context.Context, id string, raw json.RawMessage, emit func([]byte) error) {
			if *streamDelay > 0 {
				select {
				case <-time.After(*streamDelay):
				case <-ctx.Done():
					return
				}
			}
			if stall.Add(1) <= int64(*streamStall) {
				sctx, cancel := context.WithTimeout(ctx, 3*time.Second)
				x.Stream(sctx, id, raw, emit)
				cancel()
				if ctx.Err() == nil {
					line, _ := json.Marshal(map[string]any{"id": id, "error": map[string]string{"code": "stream_stalled", "message": "pane.stream: reader made no progress"}})
					_ = emit(line)
				}
				return
			}
			x.Stream(ctx, id, raw, emit)
		}}
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.transcript" && *transcriptDelay > 0 {
				time.Sleep(*transcriptDelay)
			}
			if method == "agent.transcript" && *transcriptOlderFail > 0 {
				var p struct{ Before string }
				if json.Unmarshal(params, &p) == nil && p.Before != "" && olderFails.Add(1) <= int64(*transcriptOlderFail) {
					return nil, &fakeherdr.APIError{Code: "internal", Message: "agent.transcript: older page unavailable (fixture)"}
				}
			}
			if value, err, handled := x.Handle(method, params); handled {
				return value, err
			}
			value, err := handle(method, params)
			if method == "ping" && err == nil {
				caps := value.(map[string]any)["capabilities"].(map[string]bool)
				for _, name := range []string{"pane_stream", "pane_input_stream", "pane_history", "agent_transcript", "agent_prompt", "agent_answer"} {
					caps[name] = true
				}
				if x.AskFormCapability() {
					caps["ask_form"] = true
				}
				if *askDismiss {
					caps["ask_dismiss"] = true
				}
			}
			return value, err
		}
		s.Duplex = func(ctx context.Context, id, method string, params json.RawMessage, read func() ([]byte, error), emit func([]byte) error) {
			if method == "pane.input.stream" {
				x.Duplex(ctx, id, method, params, read, emit)
			} else {
				w.gram.Duplex(ctx, id, method, params, read, emit)
			}
		}
	}
	if *accounts {
		fixture := fakeherdr.NewAccounts()
		previous := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if value, err, handled := fixture.Handle(method, params); handled {
				return value, err
			}
			return previous(method, params)
		}
	}
	if *ownerAccess != "" {
		fixture := fakeherdr.NewOwnerAccess(*ownerAccess)
		previous := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if value, err, handled := fixture.Handle(method, params); handled {
				return value, err
			}
			return previous(method, params)
		}
	}
	if *guests {
		fixture := fakeherdr.NewGuests()
		previous := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if value, err, handled := fixture.Handle(method, params); handled {
				return value, err
			}
			return previous(method, params)
		}
	}
	if *creation {
		s.SessionList = `{"sessions":[{"name":"default","default":true,"running":true},{"name":"work","default":false,"running":true}]}`
		fixture := fakeherdr.NewCreation(func(agent map[string]any) {
			var roster struct {
				Type   string           `json:"type"`
				Agents []map[string]any `json:"agents"`
			}
			if err := json.Unmarshal(set.get(), &roster); err != nil {
				log.Fatalf("creation fixture roster: %v", err)
			}
			roster.Agents = append(roster.Agents, agent)
			data, err := json.Marshal(roster)
			if err != nil {
				log.Fatalf("creation fixture roster: %v", err)
			}
			set.set(data)
		})
		previous := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if value, err, handled := fixture.Handle(method, params); handled {
				return value, err
			}
			return previous(method, params)
		}
	}
	if *topics {
		fixture := fakeherdr.NewTopics()
		fixture.Suggestions = *topicSuggestions
		fixture.Turn = *topicsTurn
		comma := func(r rune) bool { return r == ',' }
		fixture.TurnOff(strings.FieldsFunc(*topicsOff, comma)...)
		fixture.WithoutSuggestions(strings.FieldsFunc(*topicsPlain, comma)...)
		// The switch restarts an agent: the app lists the roster again.
		fixture.OnSwitch = func() { set.set(set.get()) }
		if *topicsListFail != "" {
			fixture.ListFail = func() string {
				code, err := os.ReadFile(*topicsListFail)
				if err != nil {
					return ""
				}
				return cmp.Or(strings.TrimSpace(string(code)), "topics_unreachable")
			}
		}
		events := s.Events
		s.Handle = fixture.Serve(s.Handle)
		s.Events = func(ctx context.Context, emit func([]byte) error) {
			if events != nil {
				go events(ctx, emit)
			}
			fixture.Events(ctx, emit)
		}
	}
	if s.Handle, err = bracketedWrites(*bracketedWrite, s.Handle); err != nil {
		log.Fatal(err)
	}
	if *responsesFile != "" {
		if err := serveReferenceResponses(s, *responsesFile); err != nil {
			log.Fatal(err)
		}
	}
	if *current {
		serveCurrent(s)
	}
	switch {
	case *guestRelay != "" && *guestShares != "":
		if err := serveGuestShares(s, *guestRelay, *guestShares, *guestGramInject, *guestWebOrigin); err != nil {
			log.Fatal(err)
		}
	case *guestRelay != "":
		if err := serveGuestRelay(s, *guestRelay, *guestOwnerAnswers, *guestGram, *guestMultiRequest, *guestConnectLimit, *guestPauseFile, *guestWebOrigin); err != nil {
			log.Fatal(err)
		}
	}
	addr, err := s.Listen(*listen)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("fakeherdr listening on %s; client key %s", addr, *clientKey)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if *agentsFile != "" {
		go set.follow(ctx, *agentsFile, 300*time.Millisecond)
	}
	if grow != nil && *transcriptGrow > 0 {
		go grow.GrowTranscript(ctx, *transcriptGrow)
	}
	<-ctx.Done()
}

// handler answers requests as a herdr whose agent.list behaves as mode
// says, and whose write methods change w. The modes are the agent-list
// states of herdrup's desktop references (App/DesktopReferenceMock.swift
// in herdrup).
func handler(mode string, agents func() []byte, w *writes) (func(string, json.RawMessage) (any, *fakeherdr.APIError), error) {
	var list func() any
	switch mode {
	case "populated":
		list = func() any { return json.RawMessage(agents()) }
	case "empty":
		list = func() any { return json.RawMessage(`{"type":"agent_list","agents":[]}`) }
	case "loading":
		list = func() any { select {} }
	default:
		return nil, fmt.Errorf("unknown mode %q: want populated, empty or loading", mode)
	}
	return func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "ping":
			return map[string]any{
				"type": "pong", "version": "fake", "protocol": 22,
				"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true,
					"agent_groups": true, "agent_avatar": true, "gram_upload_stream": w.uploadStream,
					"agent_session_transfer": w.actions != nil && w.actions.Transfer()},
			}, nil
		case "agent.list":
			return list(), nil
		}
		if res, err, ok := w.handle(method, params); ok {
			return res, err
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}, nil
}

// bracketedWrites is -bracketed-write: next with pane.send_bracketed_text
// advertised and served. Both writes go on to next as pane.send_text (with
// -interactions, echoed into the pane's output); one no other fixture
// serves answers herdr's ok.
func bracketedWrites(mode string, next func(string, json.RawMessage) (any, *fakeherdr.APIError)) (func(string, json.RawMessage) (any, *fakeherdr.APIError), error) {
	switch mode {
	case "":
		return next, nil
	case "on", "paste-off":
	default:
		return nil, fmt.Errorf("unknown -bracketed-write %q: want on or paste-off", mode)
	}
	fixture := &fakeherdr.PaneWrites{Bracketed: true, PasteOff: mode == "paste-off"}
	return fixture.Serve(func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		value, err := next(method, params)
		if method == "pane.send_text" && err != nil && err.Code == "unknown_method" {
			return map[string]any{"type": "ok"}, nil
		}
		return value, err
	}), nil
}
