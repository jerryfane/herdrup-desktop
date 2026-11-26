package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
)

const maxNoiseMessage = 65535
const maxNoisePlaintext = maxNoiseMessage - 16
const roundTripLimit = 60 * time.Second

// A bound share's statements (DESIGN #698 §3.3, §4): a hello's has at least
// statementLead left, and a session's statement is refreshed statementLead
// before its cutoff (the host's deadline). The lead is the transport's
// policy alone; the account's cache gives what it is asked for (minLeft).
// A refresh that fails is tried again after refreshRetry.
const (
	statementLead = 2 * time.Minute
	refreshRetry  = 15 * time.Second
)

// Statement is a HerdrUp account statement for one host: its JWS, when it
// expires, and Live, whether the sign-in it was issued in is still the
// current one (a plain answer, never an error). Nothing is sent with a
// statement that is not live.
type Statement struct {
	JWS  string
	Exp  time.Time
	Live func() bool
	// Account is the HerdrUp account it names (its sub).
	Account string
}

// StatementSource gives this device's HerdrUp account statement for host (a
// share's host id, base64url), with at least minLeft left when it can, from
// the current sign-in (internal/account StatementCache); signed out, it
// fails with ErrAccountRequired. Drop forgets jws for host if it is still
// the one held: the machine refused it.
//
// Only the attempts of one handshake (a retry after a refused statement)
// and the refreshes of the session it admitted stay in the sign-in that
// handshake started in. Every new connect takes the current sign-in's
// statement, and herdr checks it is the share's account
// (account_mismatch).
type StatementSource interface {
	Statement(ctx context.Context, host string, minLeft time.Duration) (Statement, error)
	Drop(host, jws string)
}

var cipherSuite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
var ErrRevoked = errors.New("This shared access is no longer available. Ask the owner for a new invitation.")
var ErrHostOffline = errors.New("The shared machine is offline. Try again when the owner reconnects it.")

// ErrRateLimited is the relay's 429 rate_limited: too many guest connects from
// this network (herdrup GuestError.rateLimited). A Transport that hears it waits
// before connecting again (relayBackoff).
var ErrRateLimited = errors.New("The relay is receiving too many connections. Try again shortly.")

type Features struct {
	Gram bool `json:"gram"`
	Push bool `json:"push"`
	// MultiRequest is a host that answers further requests on a session
	// after a reply (herdr guest_gate.rs serve_session, jerryfane/herdr#356).
	MultiRequest bool `json:"multi_request"`
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
	// AccountBound is a share bound to the guest's HerdrUp account at its
	// redemption: every hello for it carries a statement for that account
	// (herdr src/guest/store.rs:1121-1128), and its sessions refresh it.
	AccountBound bool `json:"accountBound"`
	// Account is the HerdrUp account a bound share is bound to: the one the
	// statement herdr admitted it with names. Its shares item lives in that
	// account's collection, whichever account is signed in later. Empty
	// for a plain share and for one saved before it was kept.
	Account string `json:"account,omitempty"`
}

func (a Access) ID() string { return a.Endpoint.HostID + "/" + a.GuestID }

// ShareID is the grant's item id in the HerdrUp account's shares
// collection: its host id in unpadded base64url, then its guest id.
func (a Access) ShareID() string { return a.Endpoint.AccountHost() + "/" + a.GuestID }

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
	// Account is an account-bound session's deadline, the statement's exp
	// plus 60 s (herdr src/guest/mod.rs:630-634); nil for a plain session.
	Account *struct {
		DeadlineUnix int64 `json:"deadline_unix"`
	} `json:"account"`
}

type session struct {
	socket  *websocket.Conn
	send    *noise.CipherState
	receive *noise.CipherState
	reply   helloReply
	// A session a call may leave for the next one (features.multi_request)
	// is read by pump, so that one left idle hears herdr end it. frames
	// carries what pump decrypted; dead closes when pump stops, err saying
	// why; stopPump ends it.
	frames   chan []byte
	dead     chan struct{}
	err      error
	stopPump context.CancelFunc
	// writeHook, when set (tests only), writes a frame in place of the socket.
	writeHook func(context.Context, []byte) error
	// firstFrameReady, when set (tests only), runs once a request's first
	// frame is ready, immediately before the write boundary checks ctx.
	firstFrameReady func()
	// handshook is when the handshake that read reply's features finished.
	handshook time.Time
	// bound is a bound session's statement (startRefresh); nil for a plain
	// session. wmu orders a refresh between the request lines' frames, and
	// stopRefresh ends the refresh.
	bound       *boundStatement
	wmu         sync.Mutex
	stopRefresh context.CancelFunc
}

// A bound share's refusals (herdr src/guest/account.rs:53-68), at its hello
// or as the reason its session closed with.
var (
	ErrAccountRequired  = errors.New("Sign in to the HerdrUp account that holds this share.")
	ErrAccountMismatch  = errors.New("This share belongs to another HerdrUp account. Sign in to that account to open it.")
	ErrStatementInvalid = errors.New("The shared machine couldn't verify your HerdrUp account. Try again.")
	ErrStatementExpired = errors.New("Your HerdrUp account check expired. Reconnect to continue.")
	ErrAccountKeysStale = errors.New("The shared machine can't check HerdrUp accounts right now. Try again later.")
	ErrDeviceRemoved    = errors.New("The owner removed this device from the shared access. Ask the owner for a new invitation.")
	ErrAccountsDisabled = errors.New("The shared machine doesn't accept HerdrUp accounts. Ask the owner for a new invitation.")
)

// ErrAccountChanged is a redemption whose sign-in ended before its hello
// went out: nothing was sent, since herdr would bind the invitation to
// whichever account's statement it carried, for good. Only a redemption not
// yet admitted says so.
var ErrAccountChanged = errors.New("Your HerdrUp account changed; open the invite again")

// ErrSignInChanged is a saved share's retry within one connect (after a
// refused statement) whose first attempt's sign-in ended (a sign-out, a
// sign-in again, another account): nothing was sent. herdr's own account
// comparison is ErrAccountMismatch.
var ErrSignInChanged = errors.New("Your HerdrUp sign-in changed. Try again.")

// errHelloStale is a connect whose statement's sign-in ended before its
// hello went out: nothing was sent.
var errHelloStale = errors.New("The shared connection was closed.")

// errRefreshStale is a refresh whose statement's sign-in, or the admitted
// session's, ended before it went out: nothing was sent.
var errRefreshStale = errors.New("the HerdrUp sign-in the session was admitted in has ended")

// expiredClose is herdr ending a session with statement_expired: a bound
// session's missed deadline, and also an owner grant's expiry, so its words
// say neither (the next hello's refusal tells them apart). It is
// ErrStatementExpired.
type expiredClose struct{}

func (expiredClose) Error() string {
	return "The shared machine ended the connection when its authorization expired. Try again."
}
func (expiredClose) Is(target error) bool { return target == ErrStatementExpired }

// helloRefused is the host's own answer refusing a hello: inside the
// authenticated Noise reply, unlike a close or a lost connection.
type helloRefused struct{ error }

func (e helloRefused) Unwrap() error { return e.error }

// freshStatementMayAdmit is a hello the host refused for its statement
// alone (statement_invalid, statement_expired), which one fresh statement
// may get past: it may have gone stale on the way, or the account's
// signing key rolled over. A close or a lost connection is no such answer.
func freshStatementMayAdmit(err error) bool {
	var refused helloRefused
	return errors.As(err, &refused) && (refused.error == ErrStatementInvalid || refused.error == ErrStatementExpired)
}

// accountRefusal is the error for one of herdr's account codes, or nil.
func accountRefusal(code string) error {
	switch code {
	case "account_required":
		return ErrAccountRequired
	case "account_mismatch":
		return ErrAccountMismatch
	case "statement_invalid":
		return ErrStatementInvalid
	case "statement_expired":
		return ErrStatementExpired
	case "account_keys_stale":
		return ErrAccountKeysStale
	case "device_removed":
		return ErrDeviceRemoved
	case "accounts_disabled":
		return ErrAccountsDisabled
	}
	return nil
}

func refusal(code string) error {
	if err := accountRefusal(code); err != nil {
		return err
	}
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
		return errHostBusy
	case "rate_limited":
		return ErrRateLimited
	}
	switch response.StatusCode {
	case 503:
		return ErrHostOffline
	case 429:
		return ErrRateLimited
	default:
		return fmt.Errorf("The guest relay refused the connection (HTTP %d).", response.StatusCode)
	}
}

// errHostBusy is the relay's host_busy, as an HTTP refusal (older relays),
// a close reason or close code 4504.
var errHostBusy = errors.New("The shared machine is busy. Try again shortly.")

// The relay's close codes for a guest upgrade it accepted only to refuse
// (herdrup GuestRelay, PR themartianapp/herdrup#610). A browser cannot read
// the HTTP status of a refused upgrade, so the relay closes with these
// instead; older relays still answer with HTTP errors (upgradeError).
const (
	closeRateLimited websocket.StatusCode = 4429
	closeHostOffline websocket.StatusCode = 4503
	closeHostBusy    websocket.StatusCode = 4504
)

func socketError(err error) error {
	var closed websocket.CloseError
	if errors.As(err, &closed) {
		switch closed.Code {
		case closeRateLimited:
			return ErrRateLimited
		case closeHostOffline:
			return ErrHostOffline
		case closeHostBusy:
			return errHostBusy
		}
		if closed.Reason == "host_busy" {
			return errHostBusy
		}
		if closed.Code == websocket.StatusNormalClosure && closed.Reason == "" {
			return io.EOF
		}
		// herdr ends a bound session with its account code as the reason
		// (statement_expired at its deadline, a refused refresh's code), which
		// the relay passes on with a normal close (GuestRelay host.ts:195).
		if closed.Code == websocket.StatusNormalClosure {
			if closed.Reason == "statement_expired" {
				return expiredClose{}
			}
			if err := accountRefusal(closed.Reason); err != nil {
				return err
			}
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

// openSession dials, handshakes and reads the host's admission. live, when
// given, is checked right before dialing and right before the hello is
// written: a hello whose statement's sign-in ended is never sent, and stale
// is the error then.
func openSession(ctx context.Context, endpoint Endpoint, identity Identity, hello []byte, live func() bool, stale error) (*session, error) {
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
	if live != nil && !live() {
		return nil, stale
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
	if live != nil && !live() {
		return nil, stale
	}
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
		return nil, helloRefused{refusal(reply.Error)}
	}
	established = true
	return &session{socket: socket, send: send, receive: receive, reply: reply}, nil
}

func (s *session) close() {
	if s.stopPump != nil {
		s.stopPump()
	}
	if s.stopRefresh != nil {
		s.stopRefresh()
	}
	_ = s.socket.CloseNow()
}

// sendLine sends line and its "\n". sent says a write of it was attempted:
// from then on herdr may have the request, even when the write reports an
// error (the bytes can leave before the connection fails, and the
// WebSocket write does not refuse an ended ctx before sending), so it must
// never go again. Until then sent is false only because ctx had already
// ended when the first frame was ready (cancelled while the request was
// encoded or encrypted, say) or the session was already known to have
// ended (ended): nothing of the request was handed over. A frame encrypted
// but not written leaves the session's cipher ahead of herdr's, so the
// caller must not use the session again (roundTrip closes it).
func (s *session) sendLine(ctx context.Context, line []byte) (sent bool, err error) {
	// A refresh (sendRefresh) goes between two lines, never inside one.
	s.wmu.Lock()
	defer s.wmu.Unlock()
	// Frame boundaries are unrelated to API line boundaries.
	line = append(line, '\n')
	for len(line) > 0 {
		length := min(len(line), maxNoisePlaintext)
		encrypted, err := s.send.Encrypt(nil, nil, line[:length])
		if err != nil {
			return sent, err
		}
		if err := s.ended(); err != nil {
			return sent, err
		}
		// The write boundary, the first frame ready: a request whose
		// context ended by now is not written.
		if !sent {
			if s.firstFrameReady != nil {
				s.firstFrameReady()
			}
			if err := ctx.Err(); err != nil {
				return false, err
			}
		}
		sent = true
		if err := s.writeFrame(ctx, encrypted); err != nil {
			return true, socketError(err)
		}
		line = line[length:]
	}
	return true, nil
}

// sendRefresh sends a bound session's in-band statement refresh: one whole
// transport message, exactly {"t":"account.refresh","account":"<jws>"}
// (herdr src/guest/link/session.rs:24-42), which herdr reads apart from the
// API's bytes and answers with nothing: a valid statement moves the
// session's deadline, any other ends the session with its code
// (session.rs:439-459).
func (s *session) sendRefresh(ctx context.Context, jws string, live func() bool) error {
	message, err := json.Marshal(struct {
		T       string `json:"t"`
		Account string `json:"account"`
	}{"account.refresh", jws})
	if err != nil {
		return err
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if err := s.ended(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Right before the write: a statement whose sign-in ended goes nowhere.
	if !live() {
		return errRefreshStale
	}
	encrypted, err := s.send.Encrypt(nil, nil, message)
	if err != nil {
		return err
	}
	if err := s.writeFrame(ctx, encrypted); err != nil {
		return socketError(err)
	}
	return nil
}

// boundStatement is what a bound session was admitted with: the statement
// and its exp, the session's cutoff (the host's deadline), where the next
// statement comes from, and whether the sign-in its hello went in is still
// the current one (admitted).
type boundStatement struct {
	statements StatementSource
	host       string
	jws        string
	exp        time.Time
	cutoff     time.Time
	admitted   func() bool
}

// startRefresh keeps a bound session alive past its deadline (herdr closes
// it then with statement_expired, session.rs:405-434): statementLead before
// its cutoff, it asks for a statement newer than the session's own (another
// jws, expiring later) and past the cutoff, and sends it in band
// (sendRefresh); the refresh is never acknowledged, so the new statement's
// exp is the next cutoff (herdr's deadline is a little later). An ask that
// fails, or gives nothing newer, is tried again after refreshRetry, until
// the cutoff passes. The refreshes stay in the sign-in the session was
// admitted in: once that has ended (signed out, or another sign-in), it
// stops, and a statement whose sign-in ended is never sent. It also stops
// when the session closes or a refresh's write fails. Nothing for a session
// that is not bound. Call it once, after startPump (when the session is
// pumped) and before the session is shared.
func (s *session) startRefresh(clock Clock) {
	if s.bound == nil {
		return
	}
	ctx, stop := context.WithCancel(context.Background())
	s.stopRefresh = stop
	go s.refresh(ctx, clock, s.bound)
}

func (s *session) refresh(ctx context.Context, clock Clock, b *boundStatement) {
	cutoff, jws, exp := b.cutoff, b.jws, b.exp
	wait := func(d time.Duration) bool {
		if d <= 0 {
			return ctx.Err() == nil
		}
		select {
		case <-ctx.Done():
			return false
		case <-clock.After(d):
			return true
		}
	}
	for {
		if !wait(cutoff.Add(-statementLead).Sub(clock.Now())) {
			return
		}
		if !b.admitted() {
			return
		}
		// One that outlives both the cutoff and the session's own
		// statement: asked for less, the cache gives the same one back.
		st, err := b.statements.Statement(ctx, b.host, later(cutoff, exp).Sub(clock.Now())+time.Second)
		switch {
		case ctx.Err() != nil:
			return
		case err == nil && st.JWS != jws && st.Exp.After(exp) && st.Exp.After(cutoff):
			if s.sendRefresh(ctx, st.JWS, func() bool { return b.admitted() && st.Live() }) != nil {
				return
			}
			cutoff, jws, exp = st.Exp, st.JWS, st.Exp
		case !b.admitted():
			// The session's sign-in ended: herdr ends it at its deadline.
			return
		case !clock.Now().Before(cutoff):
			// herdr has ended the session at its deadline.
			return
		default:
			if !wait(refreshRetry) {
				return
			}
		}
	}
}

// later is the later of a and b.
func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// ended is why a pumped session is known to have ended, or nil: herdr's
// close (or anything else ending its reader) seen before a write.
func (s *session) ended() error {
	if s.dead == nil {
		return nil
	}
	select {
	case <-s.dead:
		if s.err != nil {
			return s.err
		}
		return io.EOF
	default:
		return nil
	}
}

// writeFrame writes one encrypted frame; tests replace it through
// writeHook to fail a write whose bytes already went out.
func (s *session) writeFrame(ctx context.Context, frame []byte) error {
	if s.writeHook != nil {
		return s.writeHook(ctx, frame)
	}
	return s.socket.Write(ctx, websocket.MessageBinary, frame)
}

func (s *session) readChunk(ctx context.Context) ([]byte, error) {
	if s.frames == nil {
		return s.readFrame(ctx)
	}
	select {
	case plain := <-s.frames:
		return plain, nil
	case <-s.dead:
		// A frame that came before the end is read first.
		select {
		case plain := <-s.frames:
			return plain, nil
		default:
			return nil, s.err
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *session) readFrame(ctx context.Context) ([]byte, error) {
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

// startPump reads the session from here on in the background. Call it
// before the session is shared.
func (s *session) startPump() {
	ctx, stop := context.WithCancel(context.Background())
	s.frames, s.dead, s.stopPump = make(chan []byte, 1), make(chan struct{}), stop
	go s.pump(ctx)
}

func (s *session) pump(ctx context.Context) {
	defer close(s.dead)
	for {
		plain, err := s.readFrame(ctx)
		if err != nil {
			s.err = err
			return
		}
		select {
		case s.frames <- plain:
		case <-ctx.Done():
			s.err = ctx.Err()
			return
		}
	}
}

// quiet says an idle pumped session is still open and herdr sent nothing on
// it: herdr writes only replies, so anything else means it is spent.
func (s *session) quiet() bool {
	select {
	case <-s.dead:
		return false
	default:
		return len(s.frames) == 0
	}
}

// Accept redeems invite as this device (identity, device). With bind, and an
// invite whose host accepts accounts (Invite.Account), the redemption hello
// carries bind's statement for the host, and the share is bound to that
// HerdrUp account (herdr src/guest/store.rs:1008-1022); Access.AccountBound
// says the host bound it. herdr leaves the invitation unused when it
// refuses the statement: that exact statement is dropped and the hello goes
// once more with a fresh one, in the sign-in of the first, since herdr
// would bind the invitation to whichever account's statement it carried.
// Past a change of sign-in nothing goes out (ErrAccountChanged). A nil
// bind, or a plain invite, redeems as before.
func Accept(ctx context.Context, invite Invite, identity Identity, device string, now time.Time, bind StatementSource) (Access, error) {
	if !now.Before(invite.Expires) {
		return Access{}, ErrExpired
	}
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	host := invite.Endpoint.AccountHost()
	var statement Statement
	var connected *session
	// earlier is the first attempt's liveness, for its retry.
	var earlier func() bool
	for attempt := 0; ; attempt++ {
		statement = Statement{}
		var live func() bool
		if invite.Account && bind != nil {
			if earlier != nil && !earlier() {
				return Access{}, ErrAccountChanged
			}
			st, err := bind.Statement(ctx, host, statementLead)
			if err != nil {
				// A lookup the change of sign-in spoiled is that change;
				// any other failure in the same sign-in is itself.
				if earlier != nil && !earlier() {
					return Access{}, ErrAccountChanged
				}
				return Access{}, err
			}
			statement, live = st, st.Live
			if first := earlier; first != nil {
				live = func() bool { return first() && st.Live() }
			}
		}
		hello, err := json.Marshal(struct {
			Version  int    `json:"v"`
			InviteID string `json:"invite_id"`
			Secret   string `json:"secret"`
			Device   string `json:"device"`
			Account  string `json:"account,omitempty"`
		}{1, invite.inviteID, invite.secret, device, statement.JWS})
		if err != nil {
			return Access{}, err
		}
		connected, err = openSession(ctx, invite.Endpoint, identity, hello, live, ErrAccountChanged)
		clear(hello)
		if err == nil {
			break
		}
		if statement.JWS != "" && freshStatementMayAdmit(err) {
			// The host refused this exact statement: it never goes again.
			bind.Drop(host, statement.JWS)
			if attempt == 0 {
				earlier = live
				continue
			}
		}
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
	// A host that bound the share says so with the session's deadline; one
	// that predates accounts ignores the statement, and the share is plain.
	bound := statement.JWS != "" && reply.Account != nil
	account := ""
	if bound {
		account = statement.Account
	}
	return Access{GuestID: reply.GuestID, GuestName: fallback(reply.Name, invite.GuestName), MachineLabel: fallback(reply.MachineLabel, invite.MachineLabel), OwnerName: fallback(reply.OwnerName, invite.OwnerName), AgentName: fallback(reply.Agent.Name, invite.AgentName), AgentTarget: reply.Agent.Target, Endpoint: invite.Endpoint, AcceptedAt: now, AccountBound: bound, Account: account}, nil
}

// errNotBound is a returning hello herdr answered as a plain grant's: the
// share is not bound to an account, so no other device of it may open it.
var errNotBound = errors.New("This share is not linked to your HerdrUp account. Ask the owner for a new invitation.")

// Open adds this device to a share bound to the HerdrUp account, one
// another device of the account redeemed (its shares item): a returning
// hello with the grant's id and bind's statement for the host, and no
// invitation. herdr admits a new device whose statement names the
// share's account (src/guest/store.rs:1078 admit_returning). share holds
// what the item tells (Endpoint, GuestID and the labels); the reply gives
// the rest. A reply for another grant is a revoked share, and one without
// the account's deadline a plain one: neither is opened. As a saved
// share's connect, a hello the host refused for its statement goes once
// more with a fresh one in the sign-in of the first (ErrSignInChanged past
// a change); a first hello whose sign-in ended sends nothing.
func Open(ctx context.Context, share Access, identity Identity, now time.Time, bind StatementSource) (Access, error) {
	if bind == nil {
		return Access{}, ErrAccountRequired
	}
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	host := share.Endpoint.AccountHost()
	var connected *session
	// earlier is the first attempt's liveness, for its retry; account is
	// the account of the statement the admitted hello carried.
	var earlier func() bool
	var account string
	for attempt := 0; ; attempt++ {
		stale := errHelloStale
		if earlier != nil {
			if !earlier() {
				return Access{}, ErrSignInChanged
			}
			stale = ErrSignInChanged
		}
		st, err := bind.Statement(ctx, host, statementLead)
		if err != nil {
			if earlier != nil && !earlier() {
				return Access{}, ErrSignInChanged
			}
			return Access{}, err
		}
		live := st.Live
		if first := earlier; first != nil {
			live = func() bool { return first() && st.Live() }
		}
		hello, err := json.Marshal(struct {
			Version int    `json:"v"`
			GuestID string `json:"guest_id"`
			Account string `json:"account"`
		}{1, share.GuestID, st.JWS})
		if err != nil {
			return Access{}, err
		}
		account = st.Account
		connected, err = openSession(ctx, share.Endpoint, identity, hello, live, stale)
		if err == nil {
			break
		}
		if freshStatementMayAdmit(err) {
			// The host refused this exact statement: it never goes again.
			bind.Drop(host, st.JWS)
			if attempt == 0 {
				earlier = live
				continue
			}
		}
		return Access{}, err
	}
	defer connected.close()
	reply := connected.reply
	switch {
	case reply.GuestID != share.GuestID:
		return Access{}, ErrRevoked
	case reply.Account == nil:
		return Access{}, errNotBound
	case reply.Agent == nil || reply.Agent.Target == "":
		return Access{}, errors.New("The owner admitted this device but returned incomplete access. Ask the owner to inspect the guest grant before trying again.")
	}
	fallback := func(value, other string) string {
		if value == "" {
			return other
		}
		return value
	}
	return Access{GuestID: reply.GuestID, GuestName: fallback(reply.Name, share.GuestName), MachineLabel: fallback(reply.MachineLabel, share.MachineLabel), OwnerName: fallback(reply.OwnerName, share.OwnerName), AgentName: fallback(reply.Agent.Name, share.AgentName), AgentTarget: reply.Agent.Target, Endpoint: share.Endpoint, AcceptedAt: now, AccountBound: true, Account: account}, nil
}
