package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/jerryfane/herdrup-desktop/internal/pairing"
	"golang.org/x/crypto/ssh"
)

type PairedMachine struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

var pairingHostKeyAlgorithms = []string{ssh.KeyAlgoED25519, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}

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
	machine := Machine{Nickname: payload.User + "@" + payload.Host, Host: payload.Host, Port: 22, User: payload.User}
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
	machine.Paired = true
	// QR fingerprints use OpenSSH SHA256:base64; Parse normalizes them to the
	// same hex digest that the real SSH host-key callback verifies.
	if err := d.pins.SetPin(net.JoinHostPort(payload.Host, "22"), payload.Fingerprint); err != nil {
		return PairedMachine{}, errors.New("Couldn't save that computer's identity on this device. Nothing was sent to the computer.")
	}
	device := "Herdrup Desktop"
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
	keyPath, err := d.savePairedIdentity(identity.PrivatePEM)
	if err != nil {
		return PairedMachine{}, errors.New("Your key was added to that computer, but this device couldn't save it. Remove the herdr-pair line from ~/.ssh/authorized_keys on that computer before pairing again.")
	}
	machine.KeyPath = keyPath
	if err := d.SaveMachine(machine, replacing); err != nil {
		// Keep the only copy of an already-authorized key. A failed config write must
		// not turn recoverable local storage trouble into a lost remote credential.
		return PairedMachine{}, fmt.Errorf("The computer accepted the key, but its saved host could not be written. The private key remains at %s; add that file manually, or remove the herdr-pair line on the computer before pairing again: %w", keyPath, err)
	}
	return PairedMachine{ID: id, Nickname: machine.Nickname}, nil
}

func (d *Desk) savePairedIdentity(private []byte) (string, error) {
	dir := filepath.Join(d.dir, "identities")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(dir, "herdr-pair-*.key")
	if err != nil {
		return "", err
	}
	name := file.Name()
	if _, err := file.Write(private); err != nil {
		_ = file.Close()
		_ = os.Remove(name)
		return "", err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(name)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}
