# Herdrup Desktop

A desktop client for [herdr](https://github.com/jerryfane/herdr) on macOS, Linux and Windows:
the status board of the [herdrup](https://github.com/jerryfane/herdrup) iOS app, on your
computer. Built with [mygo](https://github.com/egoist/mygo): Go, with the screens as a web page in
the system webview (WKWebView, WebKitGTK, WebView2).

**Status: preview** (epic [#13](https://github.com/jerryfane/herdrup-desktop/issues/13)).
`v0.1.0-preview.2` adds interactive agent Terminal, omp Chat,
expanded writing for Chat and Gram, and a saved-host selection page to the
agent board, Gram attachments and desktop tray/notifications.

Select an agent to open its detail view. Terminal supports live PTY input/output,
resize, retained scrollback, search, copy and web links. Chat is available for omp
agents: paged history, Markdown and diagrams, folded thinking/tools, prompt sending
and supported single-choice questions. Other harnesses open Terminal.
External images in transcript diagrams are blocked before the browser fetches them.
Invalid diagrams stay as source text; history from an old transcript session is discarded.
The current parity branch replaces the separate writing dialog with the Swift
composer's in-card drag handle. Expanding keeps the same field, selection and draft.
Terminal quick keys are grouped, with Return pinned outside the scrollable row.
The pane's Text size menu independently remembers Chat (12–24 pt, default 16) and
Terminal (9–24 pt, default 12.5). Ctrl/Cmd +, − and 0 change or reset terminal text
without sending those shortcuts to the PTY. Font changes refit the live terminal;
Chat text reflows without scaling the surrounding controls.
Thought and Worked use the native disclosure glyphs and keep keyboard activation.
Unchanged transcript rows stay attached during refresh, preserving their focus
and expanded state. A Linux native-window check reproduced focus loss before the
fix, then passed Refresh, Enter/Space toggles, mode switches and text-size changes.
Windows disclosure keyboard interaction and full visual parity remain unverified.
The detail header uses the native machine-font status label and rounded,
minimum-bounded height when Settings text size changes. Linux native Settings
checks covered 90% and 140%, combined Chat zoom, independent terminal zoom and reset.
Chat and Gram composers measure their scaled line height instead of assuming 24 px.
Native Linux typing reproduced clipping at 140% before the fix; afterward one and
two lines fit, a sixth line scrolls behind the five-line limit, and expanded writers
retain drafts across 140%→90%→100% changes. Typing and writer expansion leave the
Chat viewport fixed. Windows/macOS composer-scale interaction is not yet verified.
Chat shares Gram's native wrap threshold: account for the action-row gap and leave
16 points of spare room before returning inline. A Linux native-window check
reproduced a clipped second line at that boundary before the fix, then verified
wrapping, stable deletion near the boundary, collapse and unchanged viewport size.
Expanded writing uses the persistent terminal's available height, including its
key-row allowance, as Swift does. Hosted macOS captures verify expansion and mode
switches preserve both viewports and the draft; writer screenshots still differ.
Prompt bubbles fit their rendered lines while retaining the original text layout
width. Linux native checks covered pointer selection, window resizing, global and
Chat font changes, search highlights and selection retained through refresh.
The hosted macOS comparison still fails the full visual gate. Windows prompt
interactions remain unverified.
Chat card labels reserve a font-derived, device-pixel-rounded minimum height.
Native Linux checks covered Settings scaling and wrapped rows at the minimum
window width. This does not correct WebKit's fractional multiline line spacing.
Chat uses Swift's fixed 26-point top fade and 48-point bottom fade away from the
tail. The native eight-point tail boundary controls the bottom fade and Jump to
latest; Linux checks covered both boundary sides and a real pointer jump.
Main Chat and subagent transcripts follow incoming messages only within eight
points of the tail. Native Linux polling checks preserved the reading position
at nine points away and followed new content at eight; subagent checks also
covered forty points away.
Host-picker headings and row labels use the existing native system-font metrics
and device-pixel-rounded intrinsic minima. Semibold section and action labels
reuse the sidebar's SF Pro weight mapping. Linux native measurements at 100% and
140% text scale passed. Hosted host-picker captures improved at both reference
sizes, but neither passes the visual gate yet.
Toolbar renders replace controls atomically and discard superseded tab changes.
Rapid Agents/Settings/Gram switching was checked in the Linux native window;
controls and the selected tab stay consistent without duplicate actions.
Earlier terminal output loads above the live screen, without a separate window or
replaying the terminal stream. Paging preserves live input, cursor state and search;
expired cursors stop paging, while transport failures remain retryable. History is
bounded to 20,000 rows. The prepend adapter uses private buffer and hyperlink
registry APIs, so xterm is pinned to 6.0.0 and upgrades require terminal-history
checks, including real hyperlink activation. Historical OSC8 targets are remapped
into the live registry; both OSC8 and visible URL links use the guarded OS opener.
Chat shows the current to-do plan once, at the end of the conversation. Its
collapsed card follows the active task; expand it to see completed and later work.
Single-choice questions appear inline, with the recommended option (or the first
option) styled as primary. Multi-part and multi-select questions direct you to Terminal.
Open question shows the full card and its prompt context; an answer updates both
the sheet and the transcript without closing the sheet.
Answer refusals stay inside that card. Changed options or an unavailable terminal
question UI offer Answer in Terminal, which dismisses the sheet and focuses the
live terminal. A successful answer stays visible while the transcript catches up;
server-reported answers supersede the local choice.
Transcript notes show their source, time and sender in a compact card. Open a note
to view its sheet; Show context expands the selectable Markdown body.
Right-click a prompt, reply or expanded thought (or press Shift+F10 while it is
focused) for Copy and Select Text. Replies also offer Copy as Markdown. Copy
uses readable text; Select Text opens one selectable surface with formatting,
list markers and table cells preserved. An open native menu keeps its original
message while the transcript updates.
Scrolling back reveals Jump to latest message. New content follows only while
you are at the tail; history prepends and switching through Terminal preserve
your reading position. Find hides the jump button while a result is selected.
Chat drafts stay local and are scoped to the host, herdr session and pane.

Instant typing ports Swift's confidence-epoch predictor to a separate xterm
overlay; guessed text never enters the terminal buffer. Settings offers Auto,
Always and Off. Auto uses measured ACK/echo delay; Always still requires a
confirmed echo before showing a new epoch, so silent/password-like input is not
predicted. Enter, unsupported input, resize, scrollback, screen changes and
disconnects clear or make predictions tentative. Wrong echoes retract guesses.
Help → Typing latency reports queue, ACK, echo, rendered-frame and prediction-draw
timings per SSH target, with Copy report and Reset. These are client render times,
not physical display scanout; as in Swift, the first output after a send is
attributed as its echo. No network type is inferred.
Linux native typing through the SSH fixture measured 16 keys and 15 confirmed
predictions, with no failed or unattributed keys. Separate real-xterm checks
verified the predicted glyph appeared before server output while the buffer
remained unchanged, and that echo, resize and Off removed the overlay.
Eight confidence/latency cases pass. `test-check prove` is inconclusive against
the previous head because these new modules do not exist there; import failure
is not claimed as behavioral regression proof.

Use the top-left back button to choose or add a saved SSH host.
Right-click a saved host (or press Shift+F10) to edit its nickname and connection
details, or delete it. Save updates the profile without connecting. The host home
uses the native readable column and app logo. Scan pairing code reads the one-time
QR printed by `herdr pair`; Add host remains available for manual setup.
Scan invite reads a shared-agent QR; Paste reads the OS clipboard only when clicked.
Both open the invitation preview and require Accept before contacting the relay.
The camera stops before preview, on cancellation, and if a pending permission
request completes after dismissal. Clipboard format checks do not read its contents.
Accepted shares appear under Shared with you. Native Linux checks covered these
paths using a canvas camera stream and the real clipboard; physical-camera and
Windows/macOS invitation scanning remain unverified.
Password connections ask again when reconnecting; passwords are not saved.
Connection and session changes invalidate open agent views. Unacknowledged terminal
input is never replayed automatically. A definite prompt rejection preserves the
draft; written or uncertain delivery clears the submitted draft and asks the reader
to check Terminal rather than accidentally submit it twice.

Pairing generates a private ed25519 identity on this device and sends only its
public key. It validates and saves the QR's SSH fingerprint before redeeming the
code, then saves the private key in the app's private `identities` directory and
records the host. Open it connects separately; pairing does not start herdr.
Paired hosts negotiate the ed25519/RSA keys advertised by `herdr pair`, without
changing existing manual hosts' negotiation order. Unconfirmed exchanges are never
retried automatically. A late camera permission result is stopped after dismissal,
and decoding or leaving the window stops capture. Linux native checks used a real
canvas MediaStream and an isolated TCP pairing endpoint; physical-camera capture
and Windows/macOS camera acceptance are not verified.

Guest invitations accept `herdrup://guest-invite#…` links, matching HTTPS relay
links, or pasted invitation text. Review shows the owner, shared agent, guest name
and this device's key fingerprint before any relay connection. Acceptance uses
Noise IK over WebSocket, authenticates the host key from the invitation, and
binds the grant to this installation's persistent X25519 identity. The private
key stays in the app's private data directory; invitation bearer secrets are not
saved with grants. Missing or corrupt identities are not silently replaced while
saved shares exist.

A saved share opens a separate Agents/Settings home with only its granted agent.
Terminal, supported omp Chat and owner-enabled Gram use fresh authenticated relay
sessions. Guest Gram uses its own read marks and reply schema; it never decodes
owner claim/read metadata. Agent renames retain the grant and update Gram routing.
Leave share forgets local access without deleting this device's identity.
The Linux native smoke exercised invalid input, cancellation before redemption,
authenticated refusal, acceptance, saved-access reload, shared pane/Gram,
rename routing, reconnect, revocation and leaving. Packaged OS link activation,
live external relay interoperability and Windows/macOS guest UI acceptance remain
unverified; handling an injected launch link is not proof of OS registration.


The Agents section's New agent action browses remote folders and installed
harnesses, creates a pane, and starts the chosen agent. Its task is placed in the
composer without sending it; press Send when ready. A blank folder retains the
daemon's current folder. Creation stays on the host/session where the sheet opened.
Only a definitive busy response while the shell still owns the foreground group
is retried, for at most two seconds. A definite start refusal closes the new empty
pane; an uncertain start is not repeated or closed automatically.
Native Linux checks exercised folder selection, rejected-start cleanup, creation
and explicit sending: zero prompt writes before Send, one afterward. The
`fakeherdr -creation -interactions` fixture starts no real model or shell process.

New terminal opens a plain shell without starting an agent. Its saved row and name
survive app restarts and belong only to that host/session. Rename updates the
daemon's pane label before saving the local name. The composer writes text without
adding Enter; use the terminal's Enter key to run it. Forget removes the local row
without closing the shell; Close terminal requires confirmation and keeps the row
if closure is unconfirmed. If saving fails, cleanup attempts to close only the new
pane. Native Linux checks exercised writing, remote rename, disk reload, forgetting,
confirmed closure and dismissal of both creation sheets on session changes.

Settings opens a split index and Machines page, not the host chooser. The machine
card and detail show the connected daemon's version and commit from
`server.staged_update`, distinct from the desktop app version. A daemon without
that method omits the line; a build without a commit shows only its version.
Closing Settings or changing host/session discards pending version replies.
It also shows saved federation states and unmatched peers. Federate requires
an explicit SSH-authority confirmation; Unfederate removes that policy immediately.
Disabled profiles cannot be enabled here. Reconnect preserves host-key checks and
asks again for an unsaved password. Copy diagnostics includes only the host label
and app version. The setup guide explains saving a machine separately from granting
federation authority. Text size saves app text scaling (90–140%) separately from
terminal point size (9–24 pt). Chat combines app scaling with its own text-size
control; terminal glyphs do not change when app text changes. Both settings survive
restart. The OMP preference chooses Chat or Terminal on opening an agent; an explicit
mode choice overrides it for that agent until the app quits. Opening the default
does not pin an override. Claude Code and Codex always open in Terminal.
Help and About open the upstream issue tracker, community, legal pages and source.
Settings → Help → Gestures explains the working desktop mouse, trackpad and
keyboard affordances in a scrollable guide. Escape, Close and Got it dismiss it
and restore focus to its Settings row; the footer remains reachable in a small
window. The instructions describe desktop controls, not unimplemented mobile
swipes or press-and-hold actions.
Linux native-window checks exercised cancellation, federation and revocation through
the SSH fixture, and read the resulting machine status back from the server.

Machines checks signed daemon updates through `server.update_check`. An explicit
confirmation binds the requested build and live/download-for-restart mode.
Cancellation sends nothing. Progress survives leaving Settings and reconnecting
to the same SSH host/session; a lost apply reply is followed by attempt identity,
never resubmitted. A previous attempt for the same build cannot count as success.
Restart-required downloads warn that a later server restart closes terminals;
the app does not restart it. Refusals offer a fresh check and confirmation.
Lost-track recovery only polls the original attempt. Unsupported or older
installations show manual instructions instead of an install button.
The card sits below the machine identity and above Connection, matching the native
Machines layout. Native reference fixtures omit this model; that screenshot-only
contract is not yet mirrored or masked in the desktop capture.
Native Linux checks exercise cancellation, refusal, download progress, success,
pending restart and manual-update cards against an isolated SSH fixture. They
do not install a real daemon or establish Windows/macOS update UI acceptance.

The Settings index shows live account/exhaustion counts, shared people/agents/invites,
enabled notification categories and text sizes. It reuses the page models and updates
only the value nodes, preserving keyboard focus. Unavailable home-box data is not
shown as an empty list. Linux native checks covered empty and mixed data, revoked
guests, expired/used invites, missing APIs, long-value truncation and keyboard
notification changes from three to four enabled categories and back.

Accounts shows subscriptions, identity, readiness and stacked usage windows. Add
registers a Claude, Codex or Kimi account on the home box. Its context menu can move
same-kind agents after confirmation, log a Claude account in or out, or remove the
registration without deleting its config directory. A known readiness blocker
disables moving agents; the server still checks each restart.
Claude sign-in uses a temporary unfocused pane, the account's `CLAUDE_CONFIG_DIR`,
and an unset `CLAUDE_CODE_OAUTH_TOKEN`. A changed account email confirms success,
never terminal success wording; re-authenticating an unchanged identity remains
unconfirmed. Closing the sheet retires its own pane, even if a newer sheet has
opened. Closing Settings or changing host/session invalidates its requests.
Linux native-window checks exercised create, rejected code, identity-confirmed
sign-in, pane cleanup, logout and remove against the isolated SSH fixture. They
did not authenticate with a real provider or restart a live agent.
Shared access combines people, pending invitations and activity from the home box
and its federated peers. Gram-sharing switches serialize rapid changes and retain
the latest choice. Revocation requires confirmation; cancelling an invitation
expires it on its own machine. Unavailable stores and unreadable logs remain
visible rather than appearing empty. The owner name is saved on this device.
The `fakeherdr -guests` fixture provides independent local/peer guest stores with
overlapping IDs, a retrying relay and an unavailable peer, without real relay
credentials or grants. Native Linux checks exercised sharing on/off, rapid
reversal, peer invite cancellation, confirmed peer revocation and owner-name
persistence across an app restart; server reads verified the other machine stayed
unchanged. The regression check also covers same-ID cross-machine isolation.
Agent actions → Share with someone creates a one-use invite for the selected
agent, including federated machine routing. The first share asks for the owner's
name; guest names follow the daemon's 32-character ASCII rule. Share Gram starts
off. The result shows the daemon's actual Gram grant, an app-link QR and a copyable
web link; legacy fragment links are converted to the path form used by Messages.
Closing or replacing the agent view invalidates its create requests. An uncertain
create result is never retried automatically.
Linux native-window checks created an invite through the isolated SSH fixture,
decoded the displayed QR and checked the clipboard link against its stored record.
This does not establish live relay redemption. Swift's native Send share sheet
still needs an approved Windows/Linux route; the app does not substitute email.
CI `41156524463` at `8755c1e` passed the same native invite scenario on Windows
and Linux. Both captured QR codes decoded independently to their fixture link;
both receipts showed default-off and opted-in Gram grants and a successful copy.
Notifications has four device-local switches: input requests, process exits,
finished turns and arriving Gram messages. Choices are saved atomically and a
failed save restores the prior switch state. A test button requests an actual
desktop alert; API support does not establish OS permission or visible delivery.
The app must stay running and connected. Exit/finished-turn alerts require live
daemon events; closing or filtering out a pane is not an exit. Existing rosters
and replayed completed turns do not alert. Gram alerts use the hidden-page unread
poll, without notifying for existing unread messages on connection.
Native Linux checks used an isolated SSH fixture and a real desktop notification
daemon: all four categories delivered, disabled categories stayed silent, keyboard
switch changes and restart persistence worked, and a failed write left the prior
choice intact. The lifecycle regression passes with the race detector and fails
on the prior implementation. Windows notification interaction is not verified.
Received HTML/SVG attachments open in an isolated in-app preview, not the system
browser. Scripts are off unless the device's “Run JavaScript in previews” setting
is enabled; changes apply to the next preview. The document has no app origin,
native bridge or storage access. Inline images/styles remain visible; network
loads, popups and navigation out of the document are blocked. With scripts enabled,
non-URL transports such as WebRTC can still signal that the document was opened,
so the setting warns about that limit. A failed protection setup never falls back
to the system browser. Other documents keep their system opener; programs remain
save-only.
Windows requires the WebView2 source-aware request filter (`ICoreWebView2_22`):
the older filter misses cross-origin iframe requests. Preview creation checks
that the native filter is installed before loading received content and fails
closed on unsupported runtimes.
Windows and Linux native checks rendered the same document with scripts off and
on, verified bridge/storage/parent isolation, and blocked fetch, WebSocket and
remote/data navigation against a local server whose unprotected control did load.
CI run `41150320378` at `9f0031f` passed these unchanged scenarios on both systems
and saved their preview screenshots. Older unsupported WebView2 runtime rejection
has not been exercised.
This is not complete Settings parity: additional preferences, daemon updates,
native invite sending and full reference comparison remain.

The sidebar can minimise to the native 64 pt rail and expand with its button or
⌘K/Ctrl+K. Rail section buttons select and expand; the Gram unread badge stays
live. Activity counts use the roster's strict needs-you count, not uncertain
agents, and its complete working count, including closed folders. Zero counts
and their separator are hidden. Linux native reference capture exercised the
accepted three-needs-you/twenty-working state; final pixel comparison is pending.

Pane attachments upload when picked, then post to the named agent on Send. One
prompt references the whole batch. A rejected prompt retains the posted file IDs:
retrying does not upload or post those files again. Saved prompts are device-local;
selecting one sends it immediately, as in Swift.
Native file-drop events share the picker/upload path in Chat and Gram. The vendored
MyGo correction accepts real Linux GTK URI-list drops even when WebKit exposes no
DOM File, and prevents an outside drop from navigating away. Only native-selected
paths authorize file access: plain URI text, synthetic events and in-page drags do
not. Chat and Gram also accept native clipboard files and images. File lists take
precedence over accompanying text; otherwise plain text keeps browser paste/undo.
WebKit image pastes with empty DOM metadata are resolved through the OS clipboard,
not by treating text as a local path. Pasted bytes use a private temporary source:
failed sends retain it for retry, while removal, successful sending and composer
closure retire it after upload/cache readers close. Picker/drop files stay borrowed
and are never deleted. Linux native-window checks covered file/image paste, matching
received hashes, plain-URI text, and staged-source cleanup; Windows clipboard
interaction acceptance remains outstanding.
The parity branch also has a shared offline microphone control for Chat and Gram.
The local whisper.cpp helper captures audio and streams partial text; no audio
provider, network upload or cloud fallback is used. Linux native-window smoke has
exercised recognition through an isolated PulseAudio monitor and microphone release
when leaving Chat. This is not physical-microphone or Windows acceptance. Linux
resource packaging also passes a native-window capture-start smoke. Windows CI
built the speech helper and installer and launched the app against the sample SSH
backend; it did not exercise Windows speech capture. macOS packaging and the
remaining visual comparison still need verification.

This is not the completed first release: full Settings/preferences, visual parity,
and remaining federation UI are unfinished. Guest invitation acceptance and saved
shared connections are implemented, but do not establish whole-app parity.
The native Linux interaction checks use an isolated sample SSH backend; macOS and
Windows desktop interaction acceptance remains separate from cross-platform builds.
Mac and Windows builds are not developer-signed; macOS notarization and real Mac/Windows
tray/notification acceptance are still outstanding. Use the preview to evaluate the implemented
features, not as a claim that those release gates have passed.

## Install

Each [release](https://github.com/jerryfane/herdrup-desktop/releases) has the installers and their
`SHA256SUMS` (`sha256sum -c --ignore-missing SHA256SUMS` checks the files you downloaded):

- **macOS** (Apple silicon and Intel): `herdrup-<version>.dmg`. Open it and drag Herdrup to
  Applications. The app is not yet signed with a Developer ID or notarized, so Gatekeeper blocks its
  first launch: open it once, then System Settings > Privacy & Security > Open Anyway.
  Only approve this specific app if you trust the download; do not disable Gatekeeper.
- **Windows** (x64): `herdrup-setup-<version>-amd64.exe` installs for the current user in
  `%LOCALAPPDATA%\Programs\Herdrup`, without administrator rights, with a Start menu shortcut and an
  uninstaller in Settings > Apps. It is not signed: SmartScreen asks first (More info > Run anyway).
  `/S` installs silently.
- **Linux** (x64), either:
  - the Debian package, for Debian and Ubuntu: `sudo apt install ./herdrup_<version>_amd64.deb`
    installs the app in `/opt/herdrup`, with its entry in the applications menu, and pulls in GTK 3
    and WebKitGTK 4.1;
  - or, on any distribution, without root: download `herdrup-<version>-linux-amd64.tar.gz` and
    `install.sh` into one folder and run `sh install.sh`. It installs the app in
    `~/.local/herdrup.app` with its menu entry (`sh install.sh --uninstall` removes it and keeps your
    settings). The app needs WebKitGTK 4.1 (`libwebkit2gtk-4.1-0`); the script says how to install it
    when it is missing.

## How it talks to herdr

Like the iOS app, it logs in over SSH and runs herdr's bridge on the machine:

- on a herdr whose `ping` advertises `api_bridge_multi`, requests go one per line through a single
  `herdr api-bridge --multi` process per herdr session, at most 16 in flight (more wait their turn), and
  replies are matched by `id`;
- every other request gets its own `herdr api-bridge <base64>` exec: while the capability is unknown, on an
  older herdr, when the `--multi` process will not start (retried after 30 s), for requests over 1 MiB, and
  for the streaming methods herdr refuses on `--multi`;
- `events.subscribe` with `events_v2` runs on its own exec channel; every event re-lists the board, with a
  30 s backstop (polling every 5 s on a herdr without `events_v2`);
- herdr sessions come from `herdr session list --json` (default only on an older herdr); switching session
  keeps the SSH connection;
- saved machines come from `machine.status`; opting one into federation or out of it runs
  `herdr machine federate|unfederate <profile id>` on its own exec channel (the id must be 32 lowercase
  hex digits, output is capped at 64 KiB), then re-reads `machine.status`. Federation peers are the
  board's agents grouped by `machine_id`;
- the host key is pinned on first contact (SHA-256 of the key, per `host:port`); a changed key is refused.

Log in with an Ed25519, ECDSA or RSA key file, or a password. The password is never saved; the saved
machines (`machines.json` in the app's data folder, one of them active) hold only the key file's path. A
`machine.json` from an earlier build is read as the active machine until `machines.json` exists.

Gram loads older messages separately from head refreshes. If an older page changes
the cached unread count, the next head poll fetches a full answer rather than
reusing the head digest. This settles delayed page counts even when a read was
already confirmed by an intervening refresh.

Successful Gram sends clear only the submitted draft revision. Text edited while
a send is pending stays in the composer, and reconnecting resets the send
acknowledgement baseline.

### Tray, notifications and menus

A tray icon (the menu bar on macOS, with the count beside it; the tooltip elsewhere) counts the agents
that need you, the board's needs-you section. Its menu opens the window, opens the window on one of
those agents, or quits. When an agent moves into needs you, a notification says so as herdr's push
does ("jarvis needs attention", over the row's subtitle): once per move, not for agents already
waiting as the app connects or switches session, and again only after the agent has left needs you.
Clicking it returns to the originating machine and session before revealing the agent.
If the agent has since been archived, its Archived disclosure opens to reveal the card.
A launch-time click waits for the window and destination board; a password-only
machine asks for credentials in the connection form. With a tray, closing the window
hides it there; quit from the tray or the menu bar (App, File, Edit and Window). On Linux the tray needs
`libayatana-appindicator3-1`; without it the app runs without one and closing the window quits.

### herdr API types

`internal/herdrapi` holds herdr's API on the wire. `types_gen.go` is generated from herdr's schema
(`docs/next/api/herdr-api.schema.json` in jerryfane/herdr), pinned to one herdr commit:

- `third_party/herdr/PROVENANCE.json` records that commit, the schema's sha256, and its `protocol` and
  `schema_version`;
- `third_party/herdr/herdr-api.schema.json` is the pinned copy, byte for byte;
- `methods.go` is the method table the schema lacks (each method's params, result `type` tags, gating
  capability and whether it streams), and `streams.go` types `pane.stream` and `gram.upload.stream`, which
  the schema skips. Both are written by hand and cite herdr's source.

Tagged unions (`ResponseResult`, `EventData`, `SubscriptionControlLine`, ...) decode to a wrapper whose
`Value` holds the variant struct; the package doc says how each schema shape maps to Go. Never edit
`types_gen.go` or the pinned schema. To follow a newer herdr, move the pin to its commit:

```sh
go run ./cmd/herdr-api-gen -commit <full herdr commit>
```

then fix whatever stops compiling and check `methods.go` against herdr's `src/api/schema.rs`.
`go run ./cmd/herdr-api-gen -generate` regenerates from the pinned copy, and
`go run ./cmd/herdr-api-gen -check -upstream` (in CI) fails when the copy differs from its record or from
herdr at the pin, or when `types_gen.go` is stale or hand-edited.

## Develop

Needs Go 1.27.3+ and Bun. On Linux, the app needs WebKitGTK 4.1 at run time (`libwebkit2gtk-4.1-0`), and
`libayatana-appindicator3-1` for its tray icon.

```sh
bun install
bun run dev        # app with hot reload
go test ./...      # Go tests, against an in-process SSH server (internal/fakeherdr)
bun run typecheck
# For an installer with offline speech, build one target at a time:
export WHISPER_SOURCE=/path/to/whisper.cpp
export HERDRUP_SPEECH_RESOURCES=/path/to/owned/local-build-scratch/speech-linux
bun speech/build.ts linux/amd64
bun run build -- -platform linux/amd64
```

The speech source must be at `927cfce34f31707e17f2bff35c349632fb9e2c3a`.
The resource builder requires CMake and a C++17 compiler. It verifies the model's
SHA-256 and bundles the helper, multilingual tiny model and license notices.
Model downloads use a backpressured Node stream pipeline: Bun 1.3.14 on Linux
can stall when writing the redirected HTTP response directly with `Bun.write`.
Set `HERDRUP_SPEECH_MODEL` to reuse an existing verified model instead of downloading
it during the build. There is no model download or audio upload at app runtime.
Use a separate resource directory per target. Build Windows speech on Windows with
Visual Studio's C++ tools and a current Windows SDK; Ubuntu's MinGW headers lack
required thread power-throttling APIs. The macOS universal build needs Xcode.
The Windows helper defines `NOMINMAX` so the native audio headers do not replace
the standard C++ `min` and `max` functions with Windows macros.
Release CI prepares these resources before building each installer.

`go run ./cmd/herdrup-probe -host <host> -user <user>` connects the way the app does and prints the
board as JSON, with no window; `-watch 1m` keeps printing updates.

`go run ./cmd/herdrup-cli -host <host> -user <user> [-session <name>] <method> '<json params>'` calls
one herdr API method through `internal/engine` and prints the result as JSON (`sessions`, `machines`, `watch`,
`pane-stream <pane_id>` and `gram.upload <file>` too; `-for 10s` bounds the streams). Pointed at
`cmd/fakeherdr` it exercises the write methods without touching a real herdr; `-machines <file>` gives the
fake saved machines (a JSON array with `machine.status`'s fields) and a `herdr machine federate|unfederate`
that changes them (`-machine-fail <stderr>` makes it fail).

### MyGo dependency corrections

Go builds use the committed `vendor/` tree. `third_party/mygo/upstream.json` pins
MyGo v0.7.1, its upstream commit and module checksum. `native-drop.patch` fixes
[#72](https://github.com/jerryfane/herdrup-desktop/issues/72);
`frame-navigation.patch` adds the subframe navigation veto required by
[#75](https://github.com/jerryfane/herdrup-desktop/issues/75). The preview applies
the same policy to top-level and subframe navigations, allowing only its initial
`about:srcdoc` document. The existing top-level navigation API keeps its semantics.
On Windows it also installs the document-source request filter before navigation:
the navigation veto alone can run after a remote iframe request has escaped.
The filter covers this window's documents, frames and dedicated workers without
installing environment-wide shared/service-worker filters.
Original TypeScript build inputs are retained with the rebuilt embedded bridge,
so application builds need no patch step.

To change Go dependencies or regenerate the corrections, use Bun **1.3.14**, Go and
GNU patch, then run `bun run vendor:mygo`. This replaces `vendor/` from `go.mod`,
checks the MyGo base, applies both patches without fuzz and rebuilds the bridge.
Do not run plain `go mod vendor` or build with `-mod=mod`: those remove or bypass
the corrections. CI regenerates the tree and rejects any difference.

Acceptance uses a real GTK drag into Chat and Gram, a posted-file byte/hash
read-back, an outside-composer drop, and rejected synthetic, in-page, plain-text
URI and non-file URI cases. A synthetic DOM `File` alone does not test this path.
The recorded Linux scenarios do not establish Windows physical-device acceptance.


## Design tokens and shared assets

Colours, fonts, the mascots, the app icon and the mermaid renderer are shared with the iOS app. Their
source of truth is herdrup ([`design/tokens.json`](https://github.com/jerryfane/herdrup/blob/main/design/tokens.json)
and the files listed in `Assets` in `internal/design/sync.go`); this repo holds copies pinned to one
herdrup commit:

- `third_party/herdrup/PROVENANCE.json` records that commit and the sha256 of every copied file;
- `third_party/herdrup/design/tokens.json` is the copied tokens file, and `public/fonts/` holds the Geist and
  IBM Plex Mono faces with their OFL licences;
- `public/herdrup/` holds `mascots.svg` (the 12 approved mascots, Herdy included, one `<symbol id="p-<id>">`
  each) and the app icon SVG; `resources/icon.png` is herdrup's 1024 px app icon, from which mygo builds every
  platform's icon;
- `public/mermaid/` holds herdrup's bundled mermaid 11.17.2 with its MIT licence and README;
- `src/tokens.css` (CSS variables and `@font-face`) and `internal/design/tokens_gen.go` (window colours)
  are generated from the tokens.

`public/` belongs to the sync: everything in it ships with the app, so `-check` fails on any file there that
the pin did not record, and on any folder it cannot read.

Never edit those files here. To change one, change it in herdrup, then move the pin to the
merged commit:

```sh
go run ./cmd/herdrup-sync -commit <full herdrup commit>
```

`go run ./cmd/herdrup-sync -check -upstream` (in CI) fails when a synced file differs from its recorded
hash or from herdrup at the pin, when a generated file is stale or hand-edited, and when a stylesheet in
`src/` uses a colour literal instead of a token variable or gives a card a coloured side stripe.

## Symbols

herdrup draws its icons with Apple's SF Symbols, which Apple licenses for its own platforms only. The
`Symbols` service gives the page each icon as a white-on-transparent image to tint with CSS `mask-image`,
with the box and baseline SwiftUI gives `Image(systemName:).font(.system(size:weight:))`:

- on macOS, `symbols_darwin.go` draws the real symbol with AppKit at run time; no SF Symbols artwork is in
  this repository or in any build;
- on Windows and Linux, `symbols_other.go` draws the nearest [Phosphor](https://phosphoricons.com) icon
  (`third_party/phosphor/`, MIT, with its licence), fitted to the box where macOS draws the symbol's ink.
  Those boxes are measured on macOS into `symbols_sfmetrics.go`; only the symbols listed there have a
  stand-in.
  Additional web-only glyphs in `third_party/phosphor/web` are pinned to
  `@phosphor-icons/core@2.1.1` and use the same MIT licence.
  Settings uses the gauge and outbound arrow from that package for Typing latency
  and external links. Internal split-view page rows omit navigation chevrons, as
  Swift does. A Linux native-window check covered keyboard opening of Typing
  latency, selection state, reset and return to Machines; both pages were inspected.

The `Symbols` workflow (on demand, macOS) checks the AppKit images against SwiftUI's at 1x, 2x and 3x,
checks `symbols_sfmetrics.go` against AppKit, and uploads every image.

## Layout

| Path | What |
|---|---|
| `main.go`, `desk.go` | the window and the `Desk` service the page calls (connect, board, state) |
| `tray.go`, `presence.go`, `trayicon/` | the tray icon and menu, needs-you notifications and the menu bar |
| `symbols*.go`, `third_party/phosphor` | the `Symbols` service: SF Symbols on macOS, Phosphor stand-ins elsewhere |
| `internal/bridge` | SSH, host key pinning, `api-bridge --multi`, streams and duplex channels |
| `internal/herdrapi`, `cmd/herdr-api-gen` | herdr's API types, generated from its pinned schema, and the method table |
| `internal/engine`, `cmd/herdrup-cli` | the typed herdr client (capability gating, event stream, pane stream, gram upload, saved machines and federation peers) and its CLI |
| `internal/herdr` | the iOS board grouping |
| `internal/live` | keeps a board current from events |
| `internal/fakeherdr`, `cmd/fakeherdr` | a canned herdr over SSH, for tests, the CI window smoke, parity (`-mode populated\|empty\|loading`), saved machines (`-machines`), a Gram inbox (`-grams sample` or a fixture file; `internal/fakeherdr/gram.go` answers every owner `gram.*` method as herdr does) and CLI write smoke; `-agents <file>` serves that agent list and re-reads it whenever it changes, telling the app over its event stream, so editing an agent's `agent_status` moves it live |
| `refshot*.go`, `cmd/refdiff` | parity with herdrup's iPad references: capture a reference state, compare it pixel by pixel |
| `internal/design`, `cmd/herdrup-sync` | design tokens: sync from herdrup, generate CSS and Go, drift checks |
| `src/` | the page (TypeScript); `src/mygo.ts` is generated by `bun run generate` |

`fakeherdr -accounts` enables an isolated Accounts fixture for native-window smoke.
It never runs auth commands or contacts providers. The code `native-smoke-code`
changes only its in-memory email; `phrase-only` prints success wording without
changing identity, for checking that the app does not falsely confirm sign-in.

## CI

Every push runs the Go and TypeScript checks and cross-builds macOS, Windows and Linux on Ubuntu. The
window smoke job builds the app with a test hook (`-X main.smoke=1`, never in releases), opens the real
window against `cmd/fakeherdr` on Linux and Windows, and on macOS on `main`, on demand and on pull
requests labelled `macos-smoke` (GitHub's hosted Macs are shared with herdrup's iOS CI), and uploads a
screenshot of each. The parity check below also runs on GitHub's hosted macOS, whose version the pixel
match was made on.
Smoke builds capture early script/resource errors and unhandled promise rejections
before the frontend module starts. Startup errors fail the window smoke even when
the expected rows eventually appear. Diagnostics include script URLs, document
readiness and page text; release builds omit the hook. Connection events retain
their data during startup, but rendering waits for the view dependencies to be
initialized. This drawing barrier is separate from notification-activation readiness.
The existing Linux and Windows smoke jobs also compile the pinned offline speech
helper and package its model and licences. That checks the platform toolchain and
bundle contents; the board screenshot is not microphone or dictation acceptance.

The current pin is Swift merge `9845ecf0743c7dce8073dc4a00db23b1fec069a8`.
The reference manifests retain each screenshot's producing head; that delivery
commit is not a claim that the desktop matches all 64 native reference images.

The parity workflow (`.github/workflows/parity.yml`, on demand and on `feat/parity-*` branches) checks
the board, Gram, Settings and detail against all 64 accepted iPad screenshots under
`design/reference/{agent-list,gram,settings,detail}` at the pinned `REFERENCES`, checked against their manifest hashes. On macOS it opens
the smoke build once per reference state and size, with `HERDRUP_REF_STATE`, `HERDRUP_REF_SIZE` (the
page area in points: the reference minus its 32 pt status bar) and `HERDRUP_REF_SCALE=2`, which makes
the web view render at 2 pixels per point although the runner's display is 1x. The page signals a drawn
state through `window.herdrupRef`. `cmd/refdiff` then compares each capture with its reference below
the status bar. Board comparisons exclude the rectangles in `cmd/refdiff/masks`: the tab bar's Liquid Glass capsule and
iPadOS's resize corner in every state, and, for `loading` only (a rect's `states`, passed as `-state`),
the detail column's glyph field, which herdrup's capture froze before its first picture.
Capture processes use `-AppleShowScrollBars WhenScrolling` to match the iPad's
overlay scroll indicators. The hosted runner's default reserves 17 pt inside
scroll views; that is not part of the native reference viewport. This argument
does not change the runner's global preference or normal desktop launches.

The accepted manifest now drives all 24 board captures, including folders,
avatars, sessions, federation and both needs-you states. `fakeherdr -responses`
serves the manifest-verified native response fixtures over SSH; its session and
avatar replies use the same production client paths as a real host. Reference
runs pin wall time to the manifest's `2026-10-28T09:41:00Z`, leaving timers live.
Each smoke/reference run uses a fresh asset origin as well as a fresh Go data
directory, so one capture cannot leave sidebar, composer or other web preferences
in the next capture or the user's regular application.

The Gram manifest adds 22 captures: latest, image, folded report, code, Saved,
search results/no matches, addressed/ambiguous attachments, empty and loading.
The fixture adapter seeds the real stateful Gram daemon store, including read
transitions, decoded files and uploads. The reference file chooser supplies only
the native fixture's verified bytes; paperclip staging and upload remain real.
Saved capture setup uses the production local-save action after opening the inbox;
it is not native context-menu acceptance. Visible image previews must finish
decoding before capture. Older-content captures use the native driver's 160 pt
scroll steps only while the complete target is obscured; already-visible images
stay at the latest-message position. Gram's ground extends beneath the home
inset without changing the feed or expanded writer's available height.
Gram comparisons use no masks.

Eight Settings captures cover the Machines index, all six saved federation
profiles plus the unsaved guest peer, empty federation, and inline About.
The Linux capture driver exercises both independent scroll containers and checks
the agent-derived totals (5 machines, 5 agents, 1 offline), not profile counts.
Settings comparisons also use no masks. Reference host naming is connection
metadata; the renderer still receives the real SSH fixture's machine statuses.

Ten detail captures cover Chat, Terminal, the collapsed/expanded inline writer,
and saved-host selection. `fakeherdr` ports the pinned native mock transcript and
terminal reset onto the real SSH transport. Source checksums are verified from
the detail manifest; these are synthetic inputs, not a live agent session.
The Chat scenario also opens, closes and reopens the agent, checking that its
rounded sidebar selection clears on Back and returns on reopening.
It also checks the latest reply's Geist font and semibold emphasis; browser-default
serif/sans fallbacks are not the native Chat typography.
Writer captures wait for the pasted draft's layout before activating the handle,
then check the same textarea, retained draft and unclipped expanded card.
Extra writer lines overlay the conversation and terminal, reserving only the
resting composer height. Captures check unchanged viewport heights during typing,
expansion and mode switching, retained drafts, and the floating key row's hit target.
Terminal uses the native horizontal-only 8 pt inset; the mode switch's stroke
does not increase its 32 pt height. Chat and Gram share 40 pt action circles
inside 44 pt targets, including the microphone while its icon changes.
The terminal's 16 ANSI colors, theme-derived 240 indexed colors and caret come
from `third_party/herdrup/terminal-theme.json`, with source hashes in the adjacent
provenance file. The parity workflow compiles `cmd/terminal-palette/main.swift`
with the reference pin's SwiftTerm `Colors.swift`, executes the native algorithm,
and compares its output byte-for-byte with the bundled palette.
Chat's composer, plan and question outlines are inset strokes, not extra layout
space. Plan rows use the font's natural line height; the transcript ends with its
12 pt padding rather than an additional last-row margin.
Replies use Swift's 8 pt block and 6 pt list-item gaps, with added leading only
between text lines. Historical plan rows retain their spacing while the current
plan appears once at the end. Question options show at most two lines.
Plan disclosures and status marks use SF Symbols on macOS, with licensed
Phosphor 2.1.1 substitutes elsewhere. Completed marks use `ChatStyle.ok` from
the pinned Swift source, not the different shared agent-state green. Plan headings,
phases, rows and the remaining-item count all follow Chat's text-size setting.
Host selection seeds only saved metadata before page startup and does not connect.
Its saved-host column uses Swift's system-font roles and application text scale,
with the native 22 pt outer inset and 60 pt minimum machine rows. It no longer
inherits the old connection form's additional 24 pt top margin. The ground
continues below the home inset. Pairing-code scanning and guest invitation acceptance
are implemented. Their device/platform limits above still prevent full onboarding acceptance.
Detail comparisons use no masks; captures do not claim native sidebar or layout parity.

refdiff counts pixels over the tolerance, and it also looks for displaced content: in 24 pt tiles it
tries moving the capture by up to 24 device pixels, and reports a tile (in the summary and the report's
`shifted`) when a move fits it much better than leaving it in place. Anti-aliasing and glyph-shape
differences change pixels in place and no move removes them; something drawn off is fitted almost
exactly by moving it back. Any displaced tile fails the comparison. The workflow uploads the captures,
diff pictures (red: over the tolerance; blue: masked; magenta: size mismatch), the reports and a
summary table. The thresholds remain `PARITY_TOL` (2) and
`PARITY_MAX_OVER_PCT` (0.15 %): the earlier 12-image baseline left at most 0.13 %
anti-aliasing differences. The full comparison at desktop `aa8828b` captured all
64 states but failed all 64 unchanged pixel/displacement gates (run `41168371428`).
Capture coverage is not visual parity. The five detail scenarios also ran in the
Linux native webview. The selected-row fix failed its native smoke
against the old frontend and passed after rebuilding, including Back/reopen.
No threshold or existing mask was relaxed.

## Releases

`.github/workflows/release.yml` builds the installers with `mygo build`: the universal macOS disk image
on GitHub's hosted macOS (its only macOS job), and the Windows installer (NSIS) and the Linux Debian
package, archive and `install.sh` cross-built on Ubuntu. It then checks each on its OS: the macOS job
mounts the disk image, checks the app's architectures and signature and runs it; a Windows job installs
silently (`/S`), runs the app and uninstalls it; a fresh Ubuntu 24.04 container installs the Debian
package with apt, runs the app under Xvfb, and installs and uninstalls with `install.sh` as a user. A
last job writes `SHA256SUMS` of all the files.

To release, set `version` in `package.json`, commit, and push the tag `v<version>` (the workflow fails
on a tag that does not match). The files and `SHA256SUMS` go on the tag's GitHub release, published
as soon as every check passes (a prerelease for a tag like `v0.2.0-beta.1`). Run on demand
(`gh workflow run release.yml --ref <branch>`), the workflow builds and checks the same files and
keeps them as artifacts of the run, with no release.

### Signing macOS builds

macOS builds are signed ad hoc for now. Developer ID signing and notarization are wired but off: the
step "Import the Developer ID certificate and notary credentials" runs only when the repository
variable `MACOS_SIGNING_IDENTITY` is set. To turn them on, add (see mygo's
[GitHub Actions](https://github.com/egoist/mygo/blob/main/docs/github-actions.md#signing-and-notarizing-macos-apps)
guide):

```sh
gh variable set MACOS_SIGNING_IDENTITY --body "Developer ID Application: <name> (<TEAMID>)"
base64 -i certificate.p12 | gh secret set MACOS_CERTIFICATE
gh secret set MACOS_CERTIFICATE_PASSWORD   # the password of the .p12
gh secret set APPLE_ID
gh secret set APPLE_TEAM_ID
gh secret set APPLE_APP_PASSWORD           # an app-specific password of the Apple ID
```

The step imports the certificate into a keychain of the job, stores the notary credentials there as
the profile `notary`, and sets `HERDRUP_SIGNING_IDENTITY` and `HERDRUP_NOTARY_KEYCHAIN`, which
`mygo.config.ts` turns into `macos.signingIdentity` and `macos.notarize`: `mygo build` then signs
with the hardened runtime, notarizes the disk image and staples it. Locally, `HERDRUP_SIGNING_IDENTITY`
alone signs; `HERDRUP_NOTARY_KEYCHAIN` set to the keychain holding a `notary` profile also notarizes.

## License

Apache-2.0
