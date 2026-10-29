# Herdrup Desktop

A desktop client for [herdr](https://github.com/jerryfane/herdr) on macOS, Linux and Windows:
the status board of the [herdrup](https://github.com/jerryfane/herdrup) iOS app, on your
computer. Built with [mygo](https://github.com/egoist/mygo): Go, with the screens as a web page in
the system webview (WKWebView, WebKitGTK, WebView2).

**Status: spike** ([#1](https://github.com/jerryfane/herdrup-desktop/issues/1), epic
[#13](https://github.com/jerryfane/herdrup-desktop/issues/13)). It connects to one machine over SSH and
shows its agents, grouped like the iOS app and updated live.

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

Needs Go 1.27.3+ and Bun. On Linux, the app needs WebKitGTK 4.1 at run time (`libwebkit2gtk-4.1-0`).

```sh
bun install
bun run dev        # app with hot reload
go test ./...      # Go tests, against an in-process SSH server (internal/fakeherdr)
bun run typecheck
bun run build -- -platform darwin/arm64,windows/amd64,linux/amd64 -skip-dmg
```

`go run ./cmd/herdrup-probe -host <host> -user <user>` connects the way the app does and prints the
board as JSON, with no window; `-watch 1m` keeps printing updates.

`go run ./cmd/herdrup-cli -host <host> -user <user> [-session <name>] <method> '<json params>'` calls
one herdr API method through `internal/engine` and prints the result as JSON (`sessions`, `machines`, `watch`,
`pane-stream <pane_id>` and `gram.upload <file>` too; `-for 10s` bounds the streams). Pointed at
`cmd/fakeherdr` it exercises the write methods without touching a real herdr; `-machines <file>` gives the
fake saved machines (a JSON array with `machine.status`'s fields) and a `herdr machine federate|unfederate`
that changes them (`-machine-fail <stderr>` makes it fail).

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

The `Symbols` workflow (on demand, macOS) checks the AppKit images against SwiftUI's at 1x, 2x and 3x,
checks `symbols_sfmetrics.go` against AppKit, and uploads every image.

## Layout

| Path | What |
|---|---|
| `main.go`, `desk.go` | the window and the `Desk` service the page calls (connect, board, state) |
| `symbols*.go`, `third_party/phosphor` | the `Symbols` service: SF Symbols on macOS, Phosphor stand-ins elsewhere |
| `internal/bridge` | SSH, host key pinning, `api-bridge --multi`, streams and duplex channels |
| `internal/herdrapi`, `cmd/herdr-api-gen` | herdr's API types, generated from its pinned schema, and the method table |
| `internal/engine`, `cmd/herdrup-cli` | the typed herdr client (capability gating, event stream, pane stream, gram upload, saved machines and federation peers) and its CLI |
| `internal/herdr` | the iOS board grouping |
| `internal/live` | keeps a board current from events |
| `internal/fakeherdr`, `cmd/fakeherdr` | a canned herdr over SSH, for tests, the CI window smoke, parity (`-mode populated\|empty\|loading`), saved machines (`-machines`) and CLI write smoke |
| `refshot*.go`, `cmd/refdiff` | parity with herdrup's iPad references: capture a reference state, compare it pixel by pixel |
| `internal/design`, `cmd/herdrup-sync` | design tokens: sync from herdrup, generate CSS and Go, drift checks |
| `src/` | the page (TypeScript); `src/mygo.ts` is generated by `bun run generate` |

## CI

Every push runs the Go and TypeScript checks and cross-builds macOS, Windows and Linux on Ubuntu. The
window smoke job builds the app with a test hook (`-X main.smoke=1`, never in releases), opens the real
window against `cmd/fakeherdr` on Linux and Windows, and on macOS on `main`, on demand and on pull
requests labelled `macos-smoke` (GitHub's hosted Macs are shared with herdrup's iOS CI), and uploads a
screenshot of each. The parity check below also runs on GitHub's hosted macOS, whose version the pixel
match was made on.

The parity workflow (`.github/workflows/parity.yml`, on demand and on `feat/parity-*` branches) checks
the agent list against herdrup's iPad screenshots (`design/reference/agent-list` in jerryfane/herdrup at
the pinned commit `REFERENCES`, fetched and checked against their manifest's sha256). On macOS it opens
the smoke build once per reference state and size, with `HERDRUP_REF_STATE`, `HERDRUP_REF_SIZE` (the
page area in points: the reference minus its 32 pt status bar) and `HERDRUP_REF_SCALE=2`, which makes
the web view render at 2 pixels per point although the runner's display is 1x. The page signals a drawn
state through `window.herdrupRef`. `cmd/refdiff` then compares each capture with its reference below
the status bar, outside the rectangles in `cmd/refdiff/masks`: the tab bar's Liquid Glass capsule and
iPadOS's resize corner in every state, and, for `loading` only (a rect's `states`, passed as `-state`),
the detail column's glyph field, which herdrup's capture froze before its first picture.

refdiff counts pixels over the tolerance, and it also looks for displaced content: in 24 pt tiles it
tries moving the capture by up to 24 device pixels, and reports a tile (in the summary and the report's
`shifted`) when a move fits it much better than leaving it in place. Anti-aliasing and glyph-shape
differences change pixels in place and no move removes them; something drawn off is fitted almost
exactly by moving it back. Any displaced tile fails the comparison. The workflow uploads the captures,
diff pictures (red: over the tolerance; blue: masked; magenta: size mismatch), the reports and a
summary table. The thresholds are `PARITY_TOL` (2) and `PARITY_MAX_OVER_PCT` (0.15 %) in the workflow:
the agent list matches the references in place, size and colour, and the at most 0.13 % left is
anti-aliasing that iOS and macOS's web view draw differently (iOS snaps glyphs to whole pixels).

## License

Apache-2.0
