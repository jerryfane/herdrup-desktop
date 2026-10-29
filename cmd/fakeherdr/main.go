// Command fakeherdr serves a canned herdr over SSH on this machine. CI runs
// it so the window smoke test has a board to show on runners without herdr.
// It is a test tool, not part of the app.
package main

import (
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

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

//go:embed agents.json
var defaultAgents []byte

func main() {
	listen := flag.String("listen", "127.0.0.1:2222", "address to serve SSH on")
	clientKey := flag.String("client-key", "fakeherdr-client.key", "write a new client private key here; only it can log in")
	agentsFile := flag.String("agents", "", "agent.list result JSON (default: built-in sample)")
	mode := flag.String("mode", "populated", "agent.list behaviour: populated (the agents JSON), empty (no agents) or loading (never answers)")
	uploadStream := flag.Bool("upload-stream", true, "advertise gram_upload_stream and serve gram.upload.stream")
	machinesFile := flag.String("machines", "", "saved SSH machines for machine.status and `herdr machine federate|unfederate`: a JSON array of objects with herdr's machine.status fields (default: none, and no machine subcommand)")
	machineFail := flag.String("machine-fail", "", "make `herdr machine federate|unfederate` exit 1 with this stderr")
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
	handle, err := handler(*mode, agents, w)
	if err != nil {
		log.Fatal(err)
	}
	s := &fakeherdr.Server{
		HostKey:       hostKey,
		Authorized:    authorized,
		Handle:        handle,
		Events:        func(ctx context.Context, emit func([]byte) error) { <-ctx.Done() },
		Duplex:        w.duplex,
		Machines:      machines,
		MachineStderr: *machineFail,
	}
	addr, err := s.Listen(*listen)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("fakeherdr listening on %s; client key %s", addr, *clientKey)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	<-ctx.Done()
}

// handler answers requests as a herdr whose agent.list behaves as mode
// says, and whose write methods change w. The modes are the agent-list
// states of herdrup's desktop references (App/DesktopReferenceMock.swift
// in herdrup).
func handler(mode string, agents []byte, w *writes) (func(string, json.RawMessage) (any, *fakeherdr.APIError), error) {
	var list func() any
	switch mode {
	case "populated":
		list = func() any { return json.RawMessage(agents) }
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
					"agent_groups": true, "agent_avatar": true, "gram_upload_stream": w.uploadStream},
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
