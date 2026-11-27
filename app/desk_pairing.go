package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"os"
	"slices"
	"strings"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/pairing"
	"golang.org/x/crypto/ssh"
)

type PairedMachine struct {
	ID string `json:"id"`
	// Label names the machine as the machine list titles it: its nickname,
	// else its host (a new pairing leaves the nickname unset).
	Label string `json:"label"`
}

// PairingPreview is what a pairing code names, for the user to confirm before
// anything is sent: the computer and its SSH host key. The token stays in Go.
type PairingPreview struct {
	Host        string `json:"host"`
	User        string `json:"user"`
	Fingerprint string `json:"fingerprint"`
}

// InspectPairingCode reads a pairing code (herdr pair's JSON, or a
// herdrup://pair# link) without contacting the computer.
func (d *Desk) InspectPairingCode(text string) (PairingPreview, error) {
	payload, err := pairing.Parse(text)
	if err != nil {
		return PairingPreview{}, err
	}
	return PairingPreview{Host: payload.Host, User: payload.User, Fingerprint: payload.SSHFingerprint()}, nil
}

// PairingLinkOpened is sent when the system opens a herdrup://pair# link with
// the app; the page takes it with TakePairingLink and asks before pairing.
var PairingLinkOpened = mygo.NewEvent[bool]("pairing-link:opened")

// queuePairingLink keeps a pairing link the system opened, in Go memory only
// and never logged: it holds a single-use pairing token, which never goes to
// the page (TakePairingLink, PairOpenedLink).
func (d *Desk) queuePairingLink(text string) bool {
	link, ok := pairing.AppLink(text)
	if !ok {
		return false
	}
	d.mu.Lock()
	d.pairingLink = pairingLink{text: link}
	d.mu.Unlock()
	PairingLinkOpened.Broadcast(true)
	return true
}

// pairingLink is an opened pairing link: its text (with the token), and once
// the page has taken it, the id the page confirms it by.
type pairingLink struct{ text, id string }

// PairingOffer is an opened pairing link as the page sees it: what it names,
// and the id Connect pairs it by. It carries no token.
type PairingOffer struct {
	ID      string         `json:"id"`
	Preview PairingPreview `json:"preview"`
}

// TakePairingLink hands the page the link the system opened as an offer to
// confirm; nil when there is none. Each take gets a new id, so only the sheet
// that took it last (after a page reload, say) can pair it. A link that is no
// pairing code is dropped, and its error shown.
func (d *Desk) TakePairingLink() (*PairingOffer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pairingLink.text == "" {
		return nil, nil
	}
	preview, err := d.InspectPairingCode(d.pairingLink.text)
	if err != nil {
		d.pairingLink = pairingLink{}
		return nil, err
	}
	d.pairingLink.id = rand.Text()
	return &PairingOffer{ID: d.pairingLink.id, Preview: preview}, nil
}

// PairOpenedLink pairs the opened link the page confirmed (Connect), once.
func (d *Desk) PairOpenedLink(ctx context.Context, id string) (PairedMachine, error) {
	d.mu.Lock()
	link := d.pairingLink
	if id != "" && link.id == id {
		d.pairingLink = pairingLink{}
	}
	d.mu.Unlock()
	if id == "" || link.id != id {
		return PairedMachine{}, errors.New("That pairing link is no longer open. Open it again.")
	}
	return d.PairMachine(ctx, link.text)
}

// DiscardPairingLink forgets the opened link the page shows as id (Cancel).
func (d *Desk) DiscardPairingLink(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if id != "" && d.pairingLink.id == id {
		d.pairingLink = pairingLink{}
	}
}

var pairingHostKeyAlgorithms = []string{ssh.KeyAlgoED25519, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}

// pairHostKeyTypes are the host key types another device's approval may pin
// (desk_pair_request.go), as pair-v1 allows: plain ed25519 and ECDSA keys,
// never RSA, DSA or a certificate. Each maps to its certificate algorithm:
// a server presenting only a certificate of the pinned key is that machine
// (bridge's pinning checks the key it certifies).
var pairHostKeyTypes = map[string]string{
	ssh.KeyAlgoED25519:  ssh.CertAlgoED25519v01,
	ssh.KeyAlgoECDSA256: ssh.CertAlgoECDSA256v01,
	ssh.KeyAlgoECDSA384: ssh.CertAlgoECDSA384v01,
	ssh.KeyAlgoECDSA521: ssh.CertAlgoECDSA521v01,
}

// hostKeyAlgorithms is what a connection to m offers for the host key: SSH's
// defaults (nil) for a machine not paired; for one another device approved,
// only the key type it pinned (one of pairHostKeyTypes), then that type's
// certificate; else herdr pair's.
func hostKeyAlgorithms(m Machine) []string {
	switch {
	case !m.Paired:
		return nil
	case m.HostKeyType != "":
		if cert, ok := pairHostKeyTypes[m.HostKeyType]; ok {
			return []string{m.HostKeyType, cert}
		}
		return []string{m.HostKeyType}
	}
	return pairingHostKeyAlgorithms
}

// sessionHostKeyFallback returns the bounded per-type algorithms tried one by
// one when a non-Paired machine with a stored pin hits HostKeyChangedError
// under Go's default preference order (which prefers ECDSA over ed25519 and
// ML-DSA). Derived from ssh.SupportedAlgorithms().HostKeys plus
// ssh.InsecureAlgorithms().HostKeys so every key and certificate type the
// default SSH dial can negotiate and pin (including ML-DSA, legacy RSA, and
// legacy DSA) is covered consistently.
func sessionHostKeyFallback() []string {
	algos := ssh.SupportedAlgorithms().HostKeys
	for _, legacy := range ssh.InsecureAlgorithms().HostKeys {
		if !slices.Contains(algos, legacy) {
			algos = append(algos, legacy)
		}
	}
	return algos
}

// readOnlyPins checks host-key pins against PinStore without ever adding or
// replacing a pin during fallback probing.
type readOnlyPins struct{ bridge.PinStore }

func (readOnlyPins) SetPin(string, string) error {
	return errors.New("pin fallback does not record new host keys")
}

// hostKeyRetryable reports whether a dial failure means this host-key type did
// not match the stored pin or was not offered by the server, so trying the next
// candidate host-key algorithm is warranted. Any other error (such as auth or
// key-exchange failure after matching the pin) ends the search immediately.
func hostKeyRetryable(err error) bool {
	var changed *bridge.HostKeyChangedError
	if errors.As(err, &changed) {
		return true
	}
	var none *ssh.AlgorithmNegotiationError
	return errors.As(err, &none) && none.What == "host key"
}

// dialWithPinFallback dials cfg; when no explicit HostKeyAlgorithms were set
// (a non-Paired machine using SSH defaults) and the server's preferred key
// misses the stored pin (HostKeyChangedError), it tries each algorithm in
// sessionHostKeyFallback using readOnlyPins (never repinning). Any error other
// than hostKeyRetryable stops the search immediately, preserving auth or
// network failures; if none matches, the initial HostKeyChangedError returns.
func dialWithPinFallback(ctx context.Context, cfg bridge.Config) (*bridge.Client, error) {
	c, err := bridge.Dial(ctx, cfg)
	var changed *bridge.HostKeyChangedError
	if len(cfg.HostKeyAlgorithms) > 0 || !errors.As(err, &changed) {
		return c, err
	}
	if cfg.Pins != nil {
		cfg.Pins = readOnlyPins{cfg.Pins}
	}
	for _, algo := range sessionHostKeyFallback() {
		tryCfg := cfg
		tryCfg.HostKeyAlgorithms = []string{algo}
		tc, terr := bridge.Dial(ctx, tryCfg)
		if terr == nil {
			return tc, nil
		}
		if hostKeyRetryable(terr) {
			continue
		}
		return nil, terr
	}
	return nil, err
}

// profilePin is the pin a machine another device's approval paired keeps
// in its profile (Machine.HostKeyPin): its connections check that key, and
// never pin another on first use.
type profilePin string

func (p profilePin) Pin(string) (string, bool, error) { return string(p), true, nil }

func (p profilePin) SetPin(string, string) error {
	return errors.New("this machine keeps the host key its pairing pinned")
}

// pinsFor is the pin store a connection to m checks its host key with: the
// profile's own pin when it has one, else the pins this computer keeps.
func (d *Desk) pinsFor(m Machine) bridge.PinStore {
	if m.HostKeyPin != "" {
		return profilePin(m.HostKeyPin)
	}
	return d.pins
}

// PairMachine pins before redemption, then persists the private key and host.
// It never connects or starts a process on the machine: Open it is a separate
// user action. Cancelling the scanner stops capture, not an accepted redemption.
func (d *Desk) PairMachine(ctx context.Context, qrText string) (PairedMachine, error) {
	if !d.pairingMu.TryLock() {
		return PairedMachine{}, errors.New("A pairing exchange is already in progress.")
	}
	defer d.pairingMu.Unlock()
	payload, err := pairing.Parse(qrText)
	if err != nil {
		return PairedMachine{}, err
	}
	if err := ctx.Err(); err != nil {
		return PairedMachine{}, err
	}
	// No nickname: the machine list titles it by its host, over its user, and
	// its shares name it by its host (machineLabel) until the person names it.
	machine := Machine{Host: payload.Host, Port: 22, User: payload.User}
	id := machineID(machine)
	d.storeMu.Lock()
	saved, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return PairedMachine{}, fmt.Errorf("Couldn't read saved machines: %w", err)
	}
	replacing := ""
	if index := saved.find(id); index >= 0 {
		machine = saved.Machines[index]
		replacing = id
	}
	// The QR's pin replaces the one before, so does its policy: herdr pair's
	// host key algorithms and the pins kept here, not the type and pin
	// another device's approval kept in the profile.
	machine.Paired, machine.HostKeyType, machine.HostKeyPin = true, "", ""
	// QR fingerprints use OpenSSH SHA256:base64; Parse normalizes them to the
	// same hex digest that the real SSH host-key callback verifies.
	if err := d.pins.SetPin(net.JoinHostPort(payload.Host, "22"), payload.Fingerprint); err != nil {
		return PairedMachine{}, errors.New("Couldn't save that computer's identity on this device. Nothing was sent to the computer.")
	}
	device := "herdrup desktop"
	if hostname, err := os.Hostname(); err == nil && hostname != "" {
		device += " on " + hostname
	}
	identity, err := pairing.GenerateIdentity(device)
	if err != nil {
		return PairedMachine{}, errors.New("Couldn't generate a private SSH identity on this device.")
	}
	defer clear(identity.PrivatePEM)
	if err := pairing.Redeem(ctx, payload, identity.PublicLine, device); err != nil {
		return PairedMachine{}, err
	}
	// Once acknowledged, finish saving even if the scanner has been dismissed.
	// Otherwise its successful remote grant would silently lose its private key.
	keyPath, err := pairing.SaveIdentity(d.dir, identity.PrivatePEM)
	if err != nil {
		return PairedMachine{}, errors.New("Your key was added to that computer, but this device couldn't save it. Remove the herdr-pair line from ~/.ssh/authorized_keys on that computer before pairing again.")
	}
	machine.KeyPath = keyPath
	if err := d.saveMachine(machine, replacing, false); err != nil {
		// Keep the only copy of an already-authorized key. A failed config write must
		// not turn recoverable local storage trouble into a lost remote credential.
		return PairedMachine{}, fmt.Errorf("The computer accepted the key, but its saved host could not be written. The private key remains at %s; add that file manually, or remove the herdr-pair line on the computer before pairing again: %w", keyPath, err)
	}
	label := strings.TrimSpace(machine.Nickname)
	if label == "" {
		label = machine.Host
	}
	return PairedMachine{ID: id, Label: label}, nil
}
