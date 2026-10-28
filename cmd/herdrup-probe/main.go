// Command herdrup-probe connects to a machine the way Herdrup Desktop does
// and prints its status board, without a window. Use it to check a
// connection or to watch the board change.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/live"
)

func main() {
	home, _ := os.UserHomeDir()
	host := flag.String("host", "127.0.0.1", "SSH host")
	port := flag.Int("port", 22, "SSH port")
	user := flag.String("user", os.Getenv("USER"), "SSH user")
	key := flag.String("key", filepath.Join(home, ".ssh", "id_ed25519"), "private key file")
	session := flag.String("session", "", "herdr session name")
	pins := flag.String("pins", filepath.Join(home, ".config", "herdrup-probe", "host-keys.json"), "host key pin file")
	watch := flag.Duration("watch", 0, "keep printing board updates for this long")
	flag.Parse()

	pem, err := os.ReadFile(*key)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	c, err := bridge.Dial(ctx, bridge.Config{
		Host: *host, Port: *port, User: *user, KeyPEM: pem,
		Session: *session, Pins: bridge.NewFilePinStore(*pins),
	})
	if err != nil {
		log.Fatal(err)
	}
	defer c.Close()

	if *watch > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *watch)
		defer cancel()
	}
	enc := json.NewEncoder(os.Stdout)
	first := true
	err = live.Watch(ctx, live.BridgeCaller{Client: c}, live.DefaultTiming, func(u live.Update) {
		if first {
			fmt.Fprintf(os.Stderr, "herdr %s, protocol %d, events_v2=%v, api_bridge_multi=%v\n",
				u.Pong.Version, u.Pong.Protocol, u.Pong.Capabilities.EventsV2, u.Pong.Capabilities.APIBridgeMulti)
		}
		fmt.Fprintf(os.Stderr, "%s agents=%d needsYou=%d\n", u.Listed.Format(time.TimeOnly), u.Board.Total, u.Board.NeedsYou)
		if first || *watch > 0 {
			_ = enc.Encode(u.Board)
		}
		first = false
		if *watch == 0 {
			stop()
		}
	})
	if err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
