package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

type pairingRequest struct {
	Type      string `json:"type"`
	Token     string `json:"token"`
	PublicKey string `json:"public_key"`
	Device    string `json:"device"`
}

func pairingListener(t *testing.T, d *Desk, reply string) (string, ssh.Signer, *atomic.Int32, <-chan pairingRequest, <-chan error) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	port := listener.Addr().(*net.TCPAddr).Port
	raw, err := json.Marshal(map[string]any{"v": 1, "host": "127.0.0.1", "port": port, "user": "pairing-user", "token": "single-use-fixture-token", "fp": ssh.FingerprintSHA256(key.PublicKey())})
	if err != nil {
		t.Fatal(err)
	}
	calls := &atomic.Int32{}
	requests := make(chan pairingRequest, 1)
	outcome := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			outcome <- err
			return
		}
		defer conn.Close()
		calls.Add(1)
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		// This is the state at the external side effect, not a check after success.
		pin, ok, err := d.pins.Pin("127.0.0.1:22")
		if err != nil || !ok || pin != bridge.Fingerprint(key.PublicKey()) {
			outcome <- fmt.Errorf("redeemed without persisted verified pin: %q %v %v", pin, ok, err)
			return
		}
		var request pairingRequest
		if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&request); err != nil {
			outcome <- err
			return
		}
		requests <- request
		if reply != "" {
			if _, err := fmt.Fprintln(conn, reply); err != nil {
				outcome <- err
				return
			}
		}
		outcome <- nil
	}()
	return string(raw), key, calls, requests, outcome
}

func TestPairingPinsBeforeRedeemAndKeepsPrivateKeyOnDevice(t *testing.T) {
	d := newDesk(t.TempDir())
	raw, hostKey, calls, requests, outcome := pairingListener(t, d, `{"type":"pair.ok"}`)
	result, err := d.PairMachine(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-outcome; err != nil {
		t.Fatal(err)
	}
	request := <-requests
	if calls.Load() != 1 || request.Type != "pair.redeem" || request.Token != "single-use-fixture-token" {
		t.Fatalf("wrong redemption: calls=%d type=%s", calls.Load(), request.Type)
	}
	public, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(request.PublicKey))
	if err != nil || len(rest) != 0 {
		t.Fatalf("redemption did not carry one public SSH key: %v", err)
	}
	if strings.Contains(request.PublicKey, "PRIVATE KEY") {
		t.Fatal("private material crossed the pairing socket")
	}
	hosts, err := newDesk(d.dir).Machines()
	if err != nil || len(hosts) != 1 || hosts[0].ID != result.ID {
		t.Fatalf("paired host was not durable: %+v %v", hosts, err)
	}
	private, err := os.ReadFile(hosts[0].KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.ParsePrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	if string(signer.PublicKey().Marshal()) != string(public.Marshal()) {
		t.Fatal("saved private key does not authorize the redeemed public key")
	}
	info, err := os.Stat(hosts[0].KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		t.Fatal("private identity readable outside its owner")
	}
	pin, ok, err := bridge.NewFilePinStore(filepath.Join(d.dir, "host-keys.json")).Pin("127.0.0.1:22")
	if err != nil || !ok || pin != bridge.Fingerprint(hostKey.PublicKey()) {
		t.Fatalf("QR pin is incompatible with actual SSH verification: %q %v", pin, err)
	}
	config, err := os.ReadFile(filepath.Join(d.dir, "machines.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), "PRIVATE KEY") || strings.Contains(string(config), "single-use-fixture-token") {
		t.Fatal("credentials leaked into saved host metadata")
	}
	// A normal sshd also offers ECDSA. Go's default order chooses that key,
	// which is NOT the ed25519 fingerprint advertised in a herdr pairing QR.
	alternate, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecdsaKey, err := ssh.NewSignerFromKey(alternate)
	if err != nil {
		t.Fatal(err)
	}
	server := &fakeherdr.Server{HostKey: hostKey, AdditionalHostKeys: []ssh.Signer{ecdsaKey}, Authorized: public,
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{map[string]any{"pane_id": "paired-pane", "agent_status": "working"}}}, nil
			default:
				return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
			}
		},
	}
	address, err := server.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	_, portText, _ := net.SplitHostPort(address)
	port, _ := strconv.Atoi(portText)
	// Only the fixture's port differs from deployed SSH's port 22. Preserve the
	// QR-derived pin bytes and the exact identity redeemed above.
	if err := d.pins.SetPin(address, pin); err != nil {
		t.Fatal(err)
	}
	legacy, err := bridge.Dial(context.Background(), bridge.Config{Host: "127.0.0.1", Port: port, User: "pairing-user", KeyPEM: private, Pins: d.pins})
	if err == nil {
		legacy.Close()
		t.Fatal("legacy negotiation unexpectedly matched the QR's ed25519 pin")
	}
	if !strings.Contains(err.Error(), "host key") {
		t.Fatalf("legacy path failed for another reason: %v", err)
	}
	machine := hosts[0].Machine
	if !machine.Paired {
		t.Fatal("paired negotiation policy was lost on disk reload")
	}
	machine.Port = port
	defer d.Disconnect()
	if err := d.Connect(machine, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "paired identity authenticated and read real board", func() bool {
		board := d.Board()
		return board != nil && board.Board.Total == 1
	})
}

func TestPairingPinFailureNeverReachesRedemption(t *testing.T) {
	d := newDesk(t.TempDir())
	blocker := filepath.Join(d.dir, "blocker")
	if err := os.WriteFile(blocker, []byte("file"), 0600); err != nil {
		t.Fatal(err)
	}
	d.pins = bridge.NewFilePinStore(filepath.Join(blocker, "pins.json"))
	raw, _, calls, _, _ := pairingListener(t, d, `{"type":"pair.ok"}`)
	if _, err := d.PairMachine(context.Background(), raw); err == nil {
		t.Fatal("failed pin reported successful pairing")
	}
	if calls.Load() != 0 {
		t.Fatal("public key was sent before host identity could be pinned")
	}
	hosts, err := d.Machines()
	if err != nil || len(hosts) != 0 {
		t.Fatalf("pin failure saved a host: %+v %v", hosts, err)
	}
}

func TestPairingUnconfirmedOrRefusedExchangeNeverRetriesOrSaves(t *testing.T) {
	for _, reply := range []string{"", `{"type":"pair.error","message":"opaque refusal"}`, `{"type":"ok"}`} {
		t.Run(fmt.Sprintf("reply-%q", reply), func(t *testing.T) {
			d := newDesk(t.TempDir())
			raw, _, calls, _, outcome := pairingListener(t, d, reply)
			if _, err := d.PairMachine(context.Background(), raw); err == nil {
				t.Fatal("unconfirmed or refused exchange saved a host")
			}
			if err := <-outcome; err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatalf("exchange was retried: %d", calls.Load())
			}
			hosts, err := d.Machines()
			if err != nil || len(hosts) != 0 {
				t.Fatalf("unconfirmed pairing persisted host: %+v %v", hosts, err)
			}
			if _, err := os.Stat(filepath.Join(d.dir, "identities")); !os.IsNotExist(err) {
				t.Fatalf("unconfirmed key was saved as usable: %v", err)
			}
		})
	}
}

// herdr-app 462716: a herdrup://pair# link (as Windows hands it over too) is
// held in Go. The page gets only an offer, what the link names and an id,
// never its token; reading it contacts nothing; Connect (PairOpenedLink with
// the latest id) pairs it once through the same redemption as a scanned code,
// and Cancel (DiscardPairingLink) forgets it.
func TestPairingLinkShowsTheComputerAndPairsOnlyOnConnect(t *testing.T) {
	d := newDesk(t.TempDir())
	raw, hostKey, calls, requests, outcome := pairingListener(t, d, `{"type":"pair.ok"}`)
	link := "herdrup://pair/#" + base64.RawURLEncoding.EncodeToString([]byte(raw))
	if d.queuePairingLink("herdrup://guest-invite#x") {
		t.Fatal("a guest invitation was taken for a pairing link")
	}
	ctx := context.Background()
	// Cancel forgets it.
	d.queuePairingLink(link)
	offer, err := d.TakePairingLink()
	if err != nil || offer == nil {
		t.Fatalf("offer %v %v", offer, err)
	}
	d.DiscardPairingLink(offer.ID)
	if again, _ := d.TakePairingLink(); again != nil {
		t.Fatalf("a discarded link was offered again: %+v", again)
	}
	if _, err := d.PairOpenedLink(ctx, offer.ID); err == nil {
		t.Fatal("a discarded link was paired")
	}
	if !d.queuePairingLink(link) {
		t.Fatal("pairing link not taken")
	}
	stale, _ := d.TakePairingLink()
	offer, err = d.TakePairingLink()
	if err != nil || offer == nil || offer.ID == stale.ID {
		t.Fatalf("offer %+v %v (stale %+v)", offer, err, stale)
	}
	page, _ := json.Marshal(offer)
	token := "single-use-fixture-token"
	if strings.Contains(string(page), token) || strings.Contains(string(page), base64.RawURLEncoding.EncodeToString([]byte(raw))) {
		t.Fatalf("the page's offer carries the token: %s", page)
	}
	if want := (PairingPreview{Host: "127.0.0.1", User: "pairing-user", Fingerprint: ssh.FingerprintSHA256(hostKey.PublicKey())}); offer.Preview != want {
		t.Fatalf("preview %+v, want %+v", offer.Preview, want)
	}
	if hosts, _ := d.Machines(); calls.Load() != 0 || len(hosts) != 0 {
		t.Fatalf("reading the link contacted the computer (%d) or saved a host (%d)", calls.Load(), len(hosts))
	}
	if _, err := d.PairOpenedLink(ctx, stale.ID); err == nil || calls.Load() != 0 {
		t.Fatalf("a superseded offer paired (%v, %d calls)", err, calls.Load())
	}
	if _, err := d.PairOpenedLink(ctx, offer.ID); err != nil {
		t.Fatal(err)
	}
	if err := <-outcome; err != nil {
		t.Fatal(err)
	}
	if r := <-requests; calls.Load() != 1 || r.Token != token {
		t.Fatalf("redemption %d %+v", calls.Load(), r.Type)
	}
	if hosts, _ := d.Machines(); len(hosts) != 1 || !hosts[0].Paired {
		t.Fatalf("hosts %+v", hosts)
	}
	// Single use: a second Connect is refused before any network contact.
	if _, err := d.PairOpenedLink(ctx, offer.ID); err == nil || !strings.Contains(err.Error(), "no longer open") {
		t.Fatalf("an opened link paired twice: %v", err)
	}
	// A bad link is dropped with its error.
	d.queuePairingLink("herdrup://pair#***")
	if bad, err := d.TakePairingLink(); bad != nil || err == nil {
		t.Fatalf("bad link offered: %+v %v", bad, err)
	}
	if again, err := d.TakePairingLink(); again != nil || err != nil {
		t.Fatalf("bad link kept: %+v %v", again, err)
	}
}
