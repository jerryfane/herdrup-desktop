// Package pairing implements herdr's single-use QR pairing exchange. Only a
// public SSH key is sent; the private key never crosses the pairing connection.
package pairing

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const invalidCode = "That code isn't a herdr pairing code. On your computer, run herdr pair and scan the code it prints."

type Payload struct {
	Host        string
	Port        int
	User        string
	Fingerprint string // canonical lowercase SHA-256 hex, matching bridge.PinStore
	token       string
}

// String redacts the bearer token even when a caller logs the parsed payload.
func (p Payload) String() string {
	return fmt.Sprintf("pairing(%s@%s:%d; token redacted)", p.User, p.Host, p.Port)
}
func (p Payload) GoString() string { return p.String() }

func Parse(raw string) (Payload, error) {
	if len(raw) > 8192 {
		return Payload{}, errors.New(invalidCode)
	}
	var wire struct {
		Version     *int    `json:"v"`
		Host        *string `json:"host"`
		Port        *int    `json:"port"`
		User        *string `json:"user"`
		Token       *string `json:"token"`
		Fingerprint *string `json:"fp"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &wire); err != nil || wire.Version == nil || wire.Host == nil || wire.Port == nil || wire.User == nil || wire.Token == nil || wire.Fingerprint == nil {
		return Payload{}, errors.New(invalidCode)
	}
	if *wire.Version != 1 {
		return Payload{}, errors.New("This pairing code was made by another version of herdr. Update the app, then scan it again.")
	}
	host, user := strings.TrimSpace(*wire.Host), strings.TrimSpace(*wire.User)
	if host == "" || user == "" || *wire.Token == "" || *wire.Port < 1 || *wire.Port > 65535 {
		return Payload{}, errors.New(invalidCode)
	}
	// Native pairing deliberately does not resolve DNS: herdr pair emits a numeric
	// IPv4 address. In particular, a scanned hostname must not trigger resolution.
	address, err := netip.ParseAddr(host)
	if err != nil || !address.Is4() {
		return Payload{}, errors.New("Couldn't reach that computer. Pairing requires the IPv4 address printed by herdr pair.")
	}
	fingerprint := strings.TrimSpace(*wire.Fingerprint)
	if fingerprint == "" {
		return Payload{}, errors.New("That computer couldn't identify itself. Make sure SSH is enabled, then run herdr pair again.")
	}
	if !strings.HasPrefix(fingerprint, "SHA256:") {
		return Payload{}, errors.New("That pairing code has an invalid SSH host-key fingerprint.")
	}
	digest, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(fingerprint, "SHA256:"))
	if err != nil || len(digest) != 32 {
		return Payload{}, errors.New("That pairing code has an invalid SSH host-key fingerprint.")
	}
	return Payload{Host: address.String(), Port: *wire.Port, User: user, Fingerprint: hex.EncodeToString(digest), token: *wire.Token}, nil
}

// Identity holds a newly generated OpenSSH private key and its public half.
// Neither the private bytes nor this value may be returned to the renderer.
type Identity struct {
	PrivatePEM []byte
	PublicLine string
}

func (Identity) String() string     { return "pairing identity (private key redacted)" }
func (i Identity) GoString() string { return i.String() }

func GenerateIdentity(device string) (Identity, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, err
	}
	defer clear(private)
	block, err := ssh.MarshalPrivateKey(private, device)
	if err != nil {
		return Identity{}, err
	}
	defer clear(block.Bytes)
	key, err := ssh.NewPublicKey(public)
	if err != nil {
		return Identity{}, err
	}
	return Identity{PrivatePEM: pem.EncodeToMemory(block), PublicLine: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))}, nil
}

// Redeem performs one bounded exchange. It never retries: a lost response can
// follow a successful authorized_keys write, and this token is single-use.
func Redeem(ctx context.Context, payload Payload, publicKey, device string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp4", net.JoinHostPort(payload.Host, strconv.Itoa(payload.Port)))
	if err != nil {
		return errors.New("Couldn't reach that computer. Check the private network connection, then run herdr pair again.")
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	request := struct {
		Type      string `json:"type"`
		Token     string `json:"token"`
		PublicKey string `json:"public_key"`
		Device    string `json:"device"`
	}{"pair.redeem", payload.token, publicKey, device}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return errors.New("Couldn't confirm pairing. Check the computer for a herdr-pair key before pairing again.")
	}
	reader := bufio.NewReaderSize(conn, 8193)
	line, err := reader.ReadSlice('\n')
	if len(line) > 8192 || (err != nil && !errors.Is(err, io.EOF)) {
		return errors.New("Couldn't confirm pairing. Check the computer for a herdr-pair key before pairing again.")
	}
	var reply struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &reply); err != nil {
		return errors.New("Got an unexpected pairing reply. Check the computer for a herdr-pair key before pairing again.")
	}
	switch reply.Type {
	case "pair.ok":
		return nil
	case "pair.error":
		return errors.New("The computer turned down this code. Pairing codes work once and expire; run herdr pair for a fresh one.")
	default:
		return errors.New("Got an unexpected pairing reply. Check the computer for a herdr-pair key before pairing again.")
	}
}
