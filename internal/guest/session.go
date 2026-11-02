package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
)

const maxNoiseMessage = 65535
const maxNoisePlaintext = maxNoiseMessage - 16
const roundTripLimit = 60 * time.Second

var cipherSuite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
var ErrRevoked = errors.New("This shared access is no longer available. Ask the owner for a new invitation.")
var ErrHostOffline = errors.New("The shared machine is offline. Try again when the owner reconnects it.")

type Features struct {
	Gram bool `json:"gram"`
	Push bool `json:"push"`
}

type Access struct {
	GuestID      string    `json:"guestID"`
	GuestName    string    `json:"guestName"`
	MachineLabel string    `json:"machineLabel"`
	OwnerName    string    `json:"ownerName"`
	AgentName    string    `json:"agentName"`
	AgentTarget  string    `json:"agentTarget"`
	Endpoint     Endpoint  `json:"endpoint"`
	AcceptedAt   time.Time `json:"acceptedAt"`
}

func (a Access) ID() string { return a.Endpoint.HostID + "/" + a.GuestID }

type helloReply struct {
	OK           *bool  `json:"ok"`
	Error        string `json:"error"`
	GuestID      string `json:"guest_id"`
	Name         string `json:"name"`
	MachineLabel string `json:"machine_label"`
	OwnerName    string `json:"owner_name"`
	Agent        *struct {
		Name   string `json:"name"`
		Target string `json:"target"`
	} `json:"agent"`
	Features Features `json:"features"`
}

type session struct {
	socket  *websocket.Conn
	send    *noise.CipherState
	receive *noise.CipherState
	reply   helloReply
}

func refusal(code string) error {
	switch code {
	case "unknown", "revoked":
		return ErrRevoked
	case "invite_used":
		return errors.New("This invitation was already used. Ask the owner for a new one.")
	case "invite_expired":
		return ErrExpired
	case "invite_invalid":
		return errors.New("The owner did not accept this invitation. Ask for a new link.")
	default:
		return errors.New("The shared machine refused this guest connection.")
	}
}

func upgradeError(response *http.Response, err error) error {
	if response == nil {
		return fmt.Errorf("connect to guest relay: %w", err)
	}
	switch response.Header.Get("X-Herdr-Guest-Error") {
	case "host_offline":
		return ErrHostOffline
	case "host_busy":
		return errors.New("The shared machine is busy. Try again shortly.")
	case "rate_limited":
		return errors.New("The relay is receiving too many connections. Try again shortly.")
	}
	switch response.StatusCode {
	case 503:
		return ErrHostOffline
	case 429:
		return errors.New("The relay is receiving too many connections. Try again shortly.")
	default:
		return fmt.Errorf("The guest relay refused the connection (HTTP %d).", response.StatusCode)
	}
}

func socketError(err error) error {
	var closed websocket.CloseError
	if errors.As(err, &closed) {
		if closed.Reason == "host_busy" {
			return errors.New("The shared machine is busy. Try again shortly.")
		}
		if closed.Code == websocket.StatusNormalClosure && closed.Reason == "" {
			return io.EOF
		}
		if closed.Code == websocket.StatusGoingAway {
			return ErrHostOffline
		}
		if closed.Code == websocket.StatusMessageTooBig {
			return errors.New("The shared machine rejected an oversized message.")
		}
		return fmt.Errorf("The shared connection closed (code %d).", closed.Code)
	}
	return err
}

func openSession(ctx context.Context, endpoint Endpoint, identity Identity, hello []byte) (*session, error) {
	address, err := endpoint.socketURL()
	if err != nil {
		return nil, err
	}
	if len(endpoint.HostPublicKey) != 32 {
		return nil, errors.New("The shared machine's saved identity is damaged.")
	}
	handshake, err := noise.NewHandshakeState(noise.Config{CipherSuite: cipherSuite, Pattern: noise.HandshakeIK, Initiator: true, Prologue: []byte("herdr-guest/1:" + endpoint.HostID), StaticKeypair: noise.DHKey{Private: identity.private, Public: identity.public}, PeerStatic: endpoint.HostPublicKey})
	if err != nil {
		return nil, fmt.Errorf("prepare secure guest connection: %w", err)
	}
	message, _, _, err := handshake.WriteMessage(nil, hello)
	if err != nil {
		return nil, fmt.Errorf("prepare secure guest hello: %w", err)
	}
	socket, response, err := websocket.Dial(ctx, address, nil)
	if err != nil {
		return nil, upgradeError(response, err)
	}
	socket.SetReadLimit(maxNoiseMessage)
	established := false
	defer func() {
		if !established {
			_ = socket.CloseNow()
		}
	}()
	if err := socket.Write(ctx, websocket.MessageBinary, message); err != nil {
		return nil, socketError(err)
	}
	kind, message, err := socket.Read(ctx)
	if err != nil {
		return nil, socketError(err)
	}
	if kind != websocket.MessageBinary {
		return nil, errors.New("The relay did not return a secure binary handshake.")
	}
	plaintext, send, receive, err := handshake.ReadMessage(nil, message)
	if err != nil {
		return nil, errors.New("Could not verify the shared machine's identity. The secure connection was refused.")
	}
	if send == nil || receive == nil {
		return nil, errors.New("The secure guest handshake did not complete.")
	}
	var reply helloReply
	if err := json.Unmarshal(plaintext, &reply); err != nil || reply.OK == nil {
		return nil, errors.New("The shared machine's secure reply is invalid.")
	}
	if !*reply.OK {
		return nil, refusal(reply.Error)
	}
	established = true
	return &session{socket: socket, send: send, receive: receive, reply: reply}, nil
}

func (s *session) close() { _ = s.socket.CloseNow() }

func (s *session) sendLine(ctx context.Context, line []byte) error {
	// Frame boundaries are unrelated to API line boundaries.
	line = append(line, '\n')
	for len(line) > 0 {
		length := min(len(line), maxNoisePlaintext)
		encrypted, err := s.send.Encrypt(nil, nil, line[:length])
		if err != nil {
			return err
		}
		if err := s.socket.Write(ctx, websocket.MessageBinary, encrypted); err != nil {
			return socketError(err)
		}
		line = line[length:]
	}
	return nil
}

func (s *session) readChunk(ctx context.Context) ([]byte, error) {
	kind, encrypted, err := s.socket.Read(ctx)
	if err != nil {
		return nil, socketError(err)
	}
	if kind != websocket.MessageBinary {
		return nil, errors.New("The relay sent an unencrypted message; the connection was refused.")
	}
	plaintext, err := s.receive.Decrypt(encrypted[:0], nil, encrypted)
	if err != nil {
		return nil, errors.New("A shared-machine message failed authentication; the connection was refused.")
	}
	return plaintext, nil
}

func Accept(ctx context.Context, invite Invite, identity Identity, device string, now time.Time) (Access, error) {
	if !now.Before(invite.Expires) {
		return Access{}, ErrExpired
	}
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	hello, err := json.Marshal(struct {
		Version  int    `json:"v"`
		InviteID string `json:"invite_id"`
		Secret   string `json:"secret"`
		Device   string `json:"device"`
	}{1, invite.inviteID, invite.secret, device})
	if err != nil {
		return Access{}, err
	}
	defer clear(hello)
	connected, err := openSession(ctx, invite.Endpoint, identity, hello)
	if err != nil {
		return Access{}, err
	}
	defer connected.close()
	reply := connected.reply
	if reply.GuestID == "" || reply.Agent == nil || reply.Agent.Target == "" {
		return Access{}, errors.New("The owner accepted the invitation but returned incomplete access. Ask the owner to inspect the guest grant before trying again.")
	}
	fallback := func(value, other string) string {
		if value == "" {
			return other
		}
		return value
	}
	return Access{GuestID: reply.GuestID, GuestName: fallback(reply.Name, invite.GuestName), MachineLabel: fallback(reply.MachineLabel, invite.MachineLabel), OwnerName: fallback(reply.OwnerName, invite.OwnerName), AgentName: fallback(reply.Agent.Name, invite.AgentName), AgentTarget: reply.Agent.Target, Endpoint: invite.Endpoint, AcceptedAt: now}, nil
}
