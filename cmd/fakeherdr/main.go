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

	s := &fakeherdr.Server{
		HostKey:    hostKey,
		Authorized: authorized,
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return map[string]any{
					"type": "pong", "version": "fake", "protocol": 22,
					"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true},
				}, nil
			case "agent.list":
				return json.RawMessage(agents), nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		},
		Events: func(ctx context.Context, emit func([]byte) error) { <-ctx.Done() },
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
