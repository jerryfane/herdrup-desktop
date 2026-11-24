<p align="center">
  <img src="docs/readme/icon.png" width="128" height="128" alt="Herdrup Desktop app icon">
</p>

<h1 align="center">Herdrup Desktop</h1>

<p align="center">
  <b>Your AI coding agents, on every computer you sit at.</b><br>
  The herdrup status board for macOS, Windows and Linux: who is working, who is done, who needs you.
</p>

<p align="center">
  <a href="https://github.com/jerryfane/herdrup-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/jerryfane/herdrup-desktop?include_prereleases&label=release&color=7A6FF0" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-7A6FF0" alt="macOS, Windows and Linux">
  <img src="https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white" alt="Go 1.27">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/jerryfane/herdrup-desktop?color=4CC38A" alt="License: Apache-2.0"></a>
  <a href="https://github.com/jerryfane/herdrup-desktop/actions/workflows/ci.yml"><img src="https://github.com/jerryfane/herdrup-desktop/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/jerryfane/herdrup-desktop"><img src="https://img.shields.io/github/stars/jerryfane/herdrup-desktop?style=flat&logo=github&color=B8C1F0" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://github.com/jerryfane/herdrup-desktop/releases/latest"><img src="docs/readme/download-macos.svg" height="48" alt="Download for macOS"></a>
  &nbsp;
  <a href="https://github.com/jerryfane/herdrup-desktop/releases/latest"><img src="docs/readme/download-windows.svg" height="48" alt="Download for Windows"></a>
  &nbsp;
  <a href="https://github.com/jerryfane/herdrup-desktop/releases/latest"><img src="docs/readme/download-linux.svg" height="48" alt="Download for Linux"></a>
</p>

<p align="center">
  <img src="docs/readme/hero.webp" width="100%" alt="Herdrup Desktop on macOS, Windows and Linux showing the agent board, and in its phone layout">
</p>

Your agents keep working while you are somewhere else: Claude Code, Codex, omp, Gemini and the rest,
each in a pane of [herdr](https://github.com/jerryfane/herdr) on your own machine. Herdrup Desktop
puts them in a window on any other computer. When one of them stops to ask something, its row turns
amber, the tray icon says so, and you answer with a click.

It is the desktop sibling of the [herdrup](https://github.com/themartianapp/herdrup) iPhone and
iPad app, with the same board, chat, terminal and Gram. herdr's JSON API knows what a pane is and
what an agent is doing, so the window shows real objects instead of a grid of characters. The raw
terminal is one click behind each agent.

**Free, open source and private.** There is no account. Your agents, terminals and chats go
straight between your computer and your own machine over SSH.

> **Status: preview.** Releases are tagged `v0.1.0-preview.N`. Installed from the `.dmg`, the
> Windows installer or `install.sh`, the app updates itself in place when a newer one is out. The
> Debian package tells you, and you update it with apt; in kiosk mode the system updates it.

---

## Know who needs you

<p align="center">
  <img src="docs/readme/board.webp" width="100%" alt="The agent board: agents asking for input, working and done, beside the glyph field">
</p>

- **One board for every agent**, grouped by what it needs: *needs you*, *working*, *done*,
  *stopped*. Colour means something: amber is waiting on you, blue is working, green is done.
- **Live**: rows change the moment an agent's status does, and folders group agents by project.
- **Away from the window**: the tray icon and system notifications say when an agent needs you.
  Choose whether *an agent finishes* means every agent or only the ones you asked.
- **All your machines**: save several hosts and switch between them; herdr's federated machines
  join the same board.

## Talk to your agents

<p align="center">
  <img src="docs/readme/chat.webp" width="100%" alt="An omp agent's chat: a question with three answers, its checklist and two running subagents">
</p>

- **Chat**: an [omp](https://github.com/can1357/oh-my-pi) agent opens as a conversation, with
  markdown, tables, code, Mermaid and SVG diagrams. Thinking and tool steps fold into one line, and
  the agent's checklist and subagents sit in the chat.
- **Questions and forms** appear as buttons and fields: answer one step at a time, review, submit.
- **Terminal**: every agent's live pane, with scrollback, search, links, Nerd Font icons and
  instant local echo on a slow link.

## One inbox with your agents

<p align="center">
  <img src="docs/readme/gram.webp" width="100%" alt="Gram: messages from agents, a file and a message waiting in the shared queue">
</p>

- **Gram** is one inbox shared by you and all your agents. They ping you there when they need input
  or have finished something.
- Send text, images and files to the shared queue, where any agent can pick them up, or @mention
  one agent. Save messages to come back to them.

## Share an agent with a guest

- Send a one-use invite from an agent's menu. Your teammate watches the live terminal and messages
  the agent from Herdrup Desktop, the iPhone app or **a web browser**, with no account and no SSH
  access.
- Traffic goes through a relay but is **end-to-end encrypted**. **Settings → Shared access** lists
  every guest, revokes access and shows an activity log.

## On a phone, too

<p align="center">
  <img src="docs/readme/phone.webp" width="720" alt="The phone layout: the agent list, an agent's chat and Gram">
</p>

At 700 px wide and narrower the window takes the iPhone app's layout: one column with the floating
tab bar, and a long press opens any right-click menu. With `HERDRUP_KIOSK=1` it runs full screen as a
device's only app, as [RoverOS](https://github.com/jerryfane/roveros) does on a Linux phone.

---

## How it works

```mermaid
flowchart LR
    app(["<b>Herdrup Desktop</b><br/>macOS · Windows · Linux"])
    guest(["<b>a guest</b><br/>app or browser"])
    relay["guest relay"]
    subgraph machine["Your machine"]
        direction TB
        herdr{{"herdr server"}}
        a1["Claude Code"] & a2["Codex"] & a3["omp · …"]
    end
    app <== "SSH · api-bridge" ==> herdr
    guest <-- "end-to-end encrypted" --> relay <--> herdr
    herdr --- a1 & a2 & a3
    herdr <-- "SSH" --> other["other machines<br/>(federation)"]
```

- **Your machine runs [herdr](https://github.com/jerryfane/herdr)**, a terminal workspace that
  runs each coding agent in a pane and knows its state. Herdrup needs the herdr fork, which adds the
  Gram, chat and live-terminal APIs.
- **The app connects over SSH** and talks to herdr's JSON API through `herdr api-bridge`. The host
  key is pinned on first use.
- **It is one Go program** built with [mygo](https://github.com/egoist/mygo): the screens are a web
  page in the system webview (WKWebView, WebView2, WebKitGTK), so the window is small and native.
- **Guests** never get SSH. A relay carries their end-to-end encrypted traffic to the one agent you
  shared.

## Quick start

**1. On your machine**, install the herdr fork and start it:

```bash
curl -fsSL https://herdrup.app/install.sh | sh   # prebuilt binary in ~/.local/bin, checksum-verified
~/.local/bin/herdr                                 # starts the server
```

The installer says so if `~/.local/bin` isn't on your `PATH`; add it there to type just `herdr`.
Upstream herdr (`brew install herdr`) lacks the APIs Herdrup needs, so make sure the fork comes first.

SSH must be enabled on that machine (on a Mac, turn on **Remote Login**), and reachable from your
computer: over [Tailscale](https://tailscale.com) or your local network.

**2. On your computer**, install Herdrup Desktop from the
[latest release](https://github.com/jerryfane/herdrup-desktop/releases/latest):

| | Download | Notes |
|---|---|---|
| **macOS** (Apple silicon and Intel) | `herdrup-<version>.dmg` | Signed with a Developer ID and notarized by Apple from 0.1.0-preview.24 on: it opens like any other app. |
| **Windows** (x64) | `herdrup-setup-<version>-amd64.exe` | Installs for the current user, no admin rights. SmartScreen asks first: More info → Run anyway. |
| **Debian, Ubuntu** (x64, arm64) | `herdrup_<version>_amd64.deb` | `sudo apt install ./herdrup_<version>_amd64.deb` |
| **Any Linux**, no root | `herdrup-<version>-linux-amd64.tar.gz` + `install.sh` | `sh install.sh` in the folder holding both. Needs WebKitGTK 4.1. |

Every release has `SHA256SUMS`: `sha256sum -c --ignore-missing SHA256SUMS` checks your download.
Use the `arm64` files on a Raspberry Pi 4 or 5 with a 64-bit OS.

**3. Connect.** Choose **Scan pairing code** and scan the code `herdr pair` prints, or, without a
camera, **Paste pairing code** (the code itself or a `herdrup://pair#…` link). **Add host** takes
the machine's address, user and SSH key instead. Your agents appear.

### Supported agents

herdr detects Claude Code, Codex, omp, Pi, Gemini, Cursor, GitHub Copilot, OpenCode, Amp, Droid and
many more, and Herdrup shows whatever herdr reports. Chat works with omp agents; every agent gets
the live terminal, Gram and status.

## Build from source

Needs Go 1.27.3+ and [Bun](https://bun.sh). On Linux, the app also needs GTK 3 and WebKitGTK 4.1.

```bash
bun install
bun run dev                                  # run the app while you edit
bun run build                                # installers for this platform, in build/
bun test && go test ./...                    # page and Go tests
```

| Path | What |
|---|---|
| [`app/`](app) | the Go program: the window, the `Desk` service the page calls, tray, updates |
| [`src/`](src) | the page (TypeScript) |
| [`internal/`](internal) | SSH bridge, herdr API types, guest sharing, Gram store, design tokens |
| [`cmd/`](cmd) | dev tools: the fake herdr used by tests and smoke runs, code generators |
| [`web/`](web) | the browser guest page |

The full feature reference, the transport, the release and signing setup, and the design system
are in **[docs/DESIGN.md](docs/DESIGN.md)**.

## Microsoft Store package

The Windows app also ships through the Microsoft Store as an MSIX package. It is the same app
built with `-X main.distribution=store`: it never updates itself or reads GitHub's releases, and
Settings, App updates says "Updates come from the Microsoft Store." The package declares the
`herdrup://` protocol, so the Store's app doesn't register it itself. [`packaging/msix`](packaging/msix)
stages exactly `herdrup.exe` and the offline speech engine that
[`speech/resources.json`](speech/resources.json) lists (`herdrup-speech.exe`, `ggml-tiny.bin`,
`whisper-LICENSE`, `speech-LICENSES`; `mygo.config.ts` ships the same list), logos made from
`resources/icon.png`, and [`AppxManifest.xml`](packaging/msix/AppxManifest.xml), for x64, and
packs them with the Windows SDK's `makeappx`. Every release run checks it (the `msix` job's `ci`
variant): packed with a placeholder identity and signed with a throwaway certificate, it installs,
opens from a `herdrup://` link with its window and keeps running, and uninstalls.

The package installs on Windows 11 and later (`MinVersion` 10.0.22000.0): the app needs the
WebView2 Runtime, which the package doesn't carry and
[Windows 11 includes](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).
On Windows 10, people use the installer from the GitHub release.

What the owner sets up, once:

1. In [Partner Center](https://partner.microsoft.com/dashboard), create the app and reserve its
   name: `herdrup`, the manifest's `DisplayName`, which must be a name reserved for the app.
2. From **Product identity**, set three repository variables, all three required (Settings →
   Secrets and variables → Actions → Variables; none is a secret):
   - `MSIX_IDENTITY_NAME`: `Package/Identity/Name`
   - `MSIX_PUBLISHER`: `Package/Identity/Publisher` (`CN=…`)
   - `MSIX_PUBLISHER_DISPLAY_NAME`: `Package/Properties/PublisherDisplayName`
3. Give the Store listing a privacy policy URL: the Store asks for one, and the app records the
   microphone for dictation, uses the camera to scan pairing codes, and sends usage pings and
   crash reports.

From then on each release also has `herdrup-<version>-store.msix` (the `msix` job's `store`
variant, which fails at once if any of the three variables is empty; without `MSIX_IDENTITY_NAME`
there is none, and the release is as before). Submitting it
stays manual: upload it in Partner Center (the app's submission, Packages). It is not signed: the
Store signs the packages it publishes
([app package requirements](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements)).
The package declares the restricted capability `runFullTrust`, as every packaged desktop app does,
so the submission asks why it needs it.

The Store takes a package version of four numbers up to 65535, the first not 0 and the last 0,
and serves the highest one it has, so `package.json`'s version maps to one that keeps releases in
order, each preview before its release:

| `package.json` | package |
|---|---|
| `X.Y.Z-preview.N` | `(X+1).Y.(Z×1000+N).0` |
| `X.Y.Z` | `(X+1).Y.(Z×1000+999).0` |

So `0.1.0-preview.23` is `1.1.23.0` and `0.1.0` is `1.1.999.0`; previews go up to 998, and Z up
to 64. To pack one on Windows, with Visual Studio's C++ tools and the Windows SDK, build the
offline speech resources first (the package needs them; see "Develop" in
[docs/DESIGN.md](docs/DESIGN.md)), then the app in Store mode, then the package. The packer deletes
and overwrites nothing: the staging folder must be new or empty and the package a new file, so
remove both before packing again:

```bash
export WHISPER_SOURCE=/path/to/whisper.cpp   # at the commit in speech/whisper.rev
export HERDRUP_SPEECH_RESOURCES=/path/to/owned/local-build-scratch/speech-windows
bun speech/build.ts windows/amd64
MYGO_LDFLAGS="-X main.distribution=store" bun run build -- -platform windows/amd64
go run ./packaging/msix pack -from build/windows-amd64 -stage build/msix -out build/herdrup-store.msix \
  -name HerdrupCI -publisher CN=HerdrupCI -publisher-display-name HerdrupCI
```

## Credits

Herdrup Desktop stands on:

- [herdr](https://github.com/jerryfane/herdr), the terminal workspace for coding agents it is a
  client for, and [herdrup](https://github.com/themartianapp/herdrup), the iOS app it follows
- [mygo](https://github.com/egoist/mygo), the Go desktop framework
- [xterm.js](https://github.com/xtermjs/xterm.js) for the terminal and
  [Mermaid](https://github.com/mermaid-js/mermaid) for diagrams
- [Phosphor Icons](https://phosphoricons.com) (MIT) for icons on Windows and Linux, and
  [Geist](https://github.com/vercel/geist-font) and IBM Plex Mono for type

## License

[Apache-2.0](LICENSE).
