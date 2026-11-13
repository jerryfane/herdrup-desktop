package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Crash reports, as herdrup's (#671): while "Share anonymous usage count" is
// on, a Go crash is written to this launch's crash file and sent to the guest
// relay's POST /v1/crash on the next launch; a web content process that dies
// sends a report without a stack at once. A report holds the app version, the
// platform, a fixed description of how it ended ("go panic", "go signal
// SIGSEGV", "webview process crashed") and the stacks as [binary, offset]
// pairs. Never the panic's message or any other text: a crash file's raw text
// is read for its program counters and deleted.
//
// Offsets are from the start of the executable's image, as Apple's
// offsetIntoBinaryTextSegment: the static address is the offset plus the
// binary's preferred base (ELF's first PT_LOAD, Mach-O's __TEXT, PE's
// ImageBase), which `go tool addr2line` symbolizes against the release binary.
// The binary's uuid is the first 16 bytes of the SHA-256 of the executable.

// crashReportRelay is the guest relay's crash endpoint (GuestRelay/src/crash.ts).
const crashReportRelay = "https://guest.herdrup.themartian.app/v1/crash"

// The relay's limits (crash.ts) and herdrup's CrashReporter's.
const (
	crashMaxBytes          = 65_536
	crashMaxStacks         = 1_024
	crashMaxFramesPerStack = 512
	crashMaxFrames         = 8_192
	// crashMaxQueued reports wait for the relay; more are not kept.
	crashMaxQueued = 20
	// crashMaxPerDay reports are sent each UTC day.
	crashMaxPerDay = 5
	crashTimeout   = 15 * time.Second
)

// crashReportURL is where reports go. HERDRUP_CRASH_REPORT_URL replaces the
// relay; smoke and reference runs send nothing otherwise.
func crashReportURL() string {
	if url := os.Getenv("HERDRUP_CRASH_REPORT_URL"); url != "" {
		return url
	}
	if smokeEnabled() || refEnabled() {
		return ""
	}
	return crashReportRelay
}

// crashReport is the relay's schema (crash.ts CrashReport), kind "crash".
type crashReport struct {
	V           int           `json:"v"`
	Kind        string        `json:"kind"`
	Version     string        `json:"version"`
	Build       string        `json:"build"`
	OS          string        `json:"os"`
	Device      string        `json:"device"`
	Termination string        `json:"termination,omitempty"`
	Truncated   bool          `json:"truncated,omitempty"`
	Binaries    []crashBinary `json:"binaries"`
	Stacks      []crashStack  `json:"stacks"`
}

type crashBinary struct {
	Name string `json:"name"`
	UUID string `json:"uuid"`
}

type crashStack struct {
	Attributed bool        `json:"attributed"`
	Frames     [][2]uint64 `json:"frames"`
}

// crashLaunch is what a launch's crash report needs from that launch: kept
// beside its crash file, since the next launch may run an updated binary.
type crashLaunch struct {
	Version string `json:"version"`
	Build   string `json:"build"`
	OS      string `json:"os"`
	Device  string `json:"device"`
	// Base is where the executable's image was loaded; 0 when unknown.
	Base uint64 `json:"base"`
	// UUID names the executable (crashBinaryUUID); "" when unknown.
	UUID string `json:"uuid"`
}

type crashReporter struct {
	// dir holds launch-<id>.txt (a launch's crash output) with its .json
	// (crashLaunch), queue/ (reports waiting) and sent.json.
	dir    string
	url    string
	usage   *usagePing
	version string
	client  *http.Client
	now    func() time.Time

	// launch describes this launch (thisLaunch), read once when first needed.
	launch     crashLaunch
	launchOnce sync.Once

	mu      sync.Mutex
	id      string // this launch's files
	armed   bool
	sending bool
}

func newCrashReporter(dir string, usage *usagePing, version string) *crashReporter {
	return &crashReporter{dir: dir, usage: usage, version: version,
		client: &http.Client{Timeout: crashTimeout}, now: time.Now}
}

func (r *crashReporter) thisLaunch() crashLaunch {
	r.launchOnce.Do(func() { r.launch = thisLaunch(r.version) })
	return r.launch
}

// thisLaunch describes the running executable.
func thisLaunch(version string) crashLaunch {
	l := crashLaunch{Version: "unknown", Build: "dev", OS: runtime.GOOS, Device: runtime.GOOS + "-" + runtime.GOARCH}
	if usagePingField.MatchString(version) {
		l.Version = version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 12 {
				l.Build = s.Value[:12]
			}
		}
	}
	if base, ok := imageBase(); ok {
		l.Base = uint64(base)
	}
	if exe, err := os.Executable(); err == nil {
		l.UUID = crashBinaryUUID(exe)
	}
	return l
}

// crashBinaryUUID is the first 16 bytes of the SHA-256 of the executable
// file, as a UUID ("" when it cannot be read): `sha256sum` of a release's
// binary finds the one a report names.
func crashBinaryUUID(exe string) string {
	f, err := os.Open(exe)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	x := strings.ToUpper(fmt.Sprintf("%x", h.Sum(nil)[:16]))
	return x[:8] + "-" + x[8:12] + "-" + x[12:16] + "-" + x[16:20] + "-" + x[20:]
}

// start runs at launch: with sharing on, it turns the crash files of earlier
// launches into reports, starts this launch's crash file and sends what waits;
// with it off it deletes everything.
func (r *crashReporter) start() {
	if r.url == "" {
		return
	}
	on, err := r.usage.enabled()
	if err != nil || !on {
		r.wipe()
		return
	}
	r.collect()
	r.arm()
	go r.send()
}

// setEnabled follows the switch: off stops this launch's crash file and
// deletes every crash file and report; on starts one.
func (r *crashReporter) setEnabled(on bool) {
	if r.url == "" {
		return
	}
	if !on {
		r.wipe()
		return
	}
	r.arm()
}

func (r *crashReporter) queueDir() string { return filepath.Join(r.dir, "queue") }

// wipe stops this launch's crash output and deletes all crash data.
func (r *crashReporter) wipe() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.armed {
		_ = debug.SetCrashOutput(nil, debug.CrashOptions{})
		r.armed = false
	}
	_ = os.RemoveAll(r.dir)
}

// arm sends this launch's crashes to its crash file, with every frame's
// program counter (traceback "system").
func (r *crashReporter) arm() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.armed {
		return
	}
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		return
	}
	if r.id == "" {
		r.id = strconv.FormatInt(r.now().UnixNano(), 36) + "-" + randomToken(6)
	}
	meta, err := json.Marshal(r.thisLaunch())
	if err != nil || os.WriteFile(filepath.Join(r.dir, "launch-"+r.id+".json"), meta, 0o600) != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(r.dir, "launch-"+r.id+".txt"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	debug.SetTraceback("system")
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		log.Printf("crash reports: %v", err)
		return
	}
	r.armed = true
}

// collect turns the crash files of earlier launches into reports and deletes
// them: an empty one is a launch that did not crash.
func (r *crashReporter) collect() {
	r.mu.Lock()
	defer r.mu.Unlock()
	metas, _ := filepath.Glob(filepath.Join(r.dir, "launch-*.json"))
	for _, meta := range metas {
		base := strings.TrimSuffix(meta, ".json")
		if r.id != "" && filepath.Base(base) == "launch-"+r.id {
			continue
		}
		text, _ := os.ReadFile(base + ".txt")
		var l crashLaunch
		if len(bytes.TrimSpace(text)) > 0 {
			if data, err := os.ReadFile(meta); err == nil && json.Unmarshal(data, &l) == nil {
				r.enqueueLocked(crashFromOutput(string(text), l))
			}
		}
		_ = os.Remove(base + ".txt")
		_ = os.Remove(meta)
	}
}

// renderGone reports a web content process that ended (mygo's
// OnRenderProcessGone): no stack, only how it ended.
func (r *crashReporter) renderGone(reason string) {
	if r.url == "" {
		return
	}
	if on, err := r.usage.enabled(); err != nil || !on {
		return
	}
	l := r.thisLaunch()
	r.mu.Lock()
	r.enqueueLocked(crashReport{V: 1, Kind: "crash", Version: l.Version, Build: l.Build,
		OS: l.OS, Device: l.Device, Termination: renderTermination(reason),
		Binaries: []crashBinary{}, Stacks: []crashStack{}})
	r.mu.Unlock()
	go r.send()
}

// renderTermination is "webview process <reason>" for mygo's known reasons.
func renderTermination(reason string) string {
	switch reason {
	case "crashed", "exceeded memory limit", "terminated by API", "terminated", "browser-exited", "unresponsive":
		return "webview process " + reason
	}
	return "webview process exited"
}

func (r *crashReporter) enqueueLocked(report crashReport) {
	q := r.queueDir()
	if err := os.MkdirAll(q, 0o700); err != nil {
		return
	}
	if queued, _ := os.ReadDir(q); len(queued) >= crashMaxQueued {
		return
	}
	body := fitCrashReport(report)
	name := strconv.FormatInt(r.now().UnixNano(), 36) + "-" + randomToken(6) + ".json"
	_ = os.WriteFile(filepath.Join(q, name), body, 0o600)
}

type crashSent struct {
	Day   string `json:"day"`
	Count int    `json:"count"`
}

// send posts queued reports, oldest first, at most crashMaxPerDay a UTC day.
// A report the relay refuses (4xx other than 429) is dropped; one it could not
// take now (429, 5xx, no answer) waits for the next launch or report.
func (r *crashReporter) send() {
	r.mu.Lock()
	if r.sending || r.url == "" {
		r.mu.Unlock()
		return
	}
	r.sending = true
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.sending = false; r.mu.Unlock() }()
	queued, _ := os.ReadDir(r.queueDir())
	slices.SortFunc(queued, func(a, b os.DirEntry) int { return strings.Compare(a.Name(), b.Name()) })
	sentPath := filepath.Join(r.dir, "sent.json")
	var sent crashSent
	if data, err := os.ReadFile(sentPath); err == nil {
		_ = json.Unmarshal(data, &sent)
	}
	today := r.now().UTC().Format("2006-01-02")
	if sent.Day != today {
		sent = crashSent{Day: today}
	}
	for _, q := range queued {
		if sent.Count >= crashMaxPerDay {
			break
		}
		if on, err := r.usage.enabled(); err != nil || !on {
			return
		}
		path := filepath.Join(r.queueDir(), q.Name())
		body, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		status := r.post(body)
		if status == 0 || status == http.StatusTooManyRequests || status >= 500 {
			break
		}
		_ = os.Remove(path)
		sent.Count++
		if data, err := json.Marshal(sent); err == nil {
			_ = os.WriteFile(sentPath, data, 0o600)
		}
	}
}

// post sends one report and returns the relay's status; 0 when none came.
func (r *crashReporter) post(body []byte) int {
	ctx, cancel := context.WithTimeout(context.Background(), crashTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
	if err != nil {
		return 0
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode
}

var (
	crashGoroutine = regexp.MustCompile(`^goroutine \d+ .*:$`)
	crashFramePC   = regexp.MustCompile(` pc=0x([0-9a-f]{1,16})$`)
	crashSignal    = regexp.MustCompile(`^\[signal (SIG[A-Z0-9]{1,10})[: ]`)
	crashException = regexp.MustCompile(`^Exception (0x[0-9a-f]{1,8}) `)
)

// crashFromOutput reads a Go crash's output (traceback "system") for how it
// ended and its goroutines' program counters; the panicking goroutine comes
// first. No other text of it is kept.
func crashFromOutput(text string, l crashLaunch) crashReport {
	report := crashReport{V: 1, Kind: "crash", Version: l.Version, Build: l.Build, OS: l.OS, Device: l.Device,
		Binaries: []crashBinary{}, Stacks: []crashStack{}}
	how, signal := "", ""
	stack := -1
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimRight(line, "\r")
		switch {
		case how == "" && strings.HasPrefix(line, "panic: "):
			how = "go panic"
		case how == "" && strings.HasPrefix(line, "fatal error: "):
			how = "go fatal error"
		}
		if m := crashSignal.FindStringSubmatch(line); m != nil && signal == "" {
			signal = "signal " + m[1]
		} else if m := crashException.FindStringSubmatch(line); m != nil && signal == "" {
			signal = "exception " + m[1]
		}
		if crashGoroutine.MatchString(line) {
			report.Stacks = append(report.Stacks, crashStack{Attributed: len(report.Stacks) == 0, Frames: [][2]uint64{}})
			stack = len(report.Stacks) - 1
			continue
		}
		if stack < 0 || !strings.HasPrefix(line, "\t") || l.Base == 0 || l.UUID == "" {
			continue
		}
		m := crashFramePC.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pc, err := strconv.ParseUint(m[1], 16, 64)
		if err != nil || pc < l.Base || len(report.Stacks[stack].Frames) >= crashMaxFramesPerStack {
			continue
		}
		report.Stacks[stack].Frames = append(report.Stacks[stack].Frames, [2]uint64{0, pc - l.Base})
	}
	if how == "" {
		how = "go crash"
	}
	if signal != "" {
		how += " " + signal
	}
	report.Termination = how
	// The relay takes no empty stack.
	report.Stacks = slices.DeleteFunc(report.Stacks, func(s crashStack) bool { return len(s.Frames) == 0 })
	if len(report.Stacks) > 0 {
		report.Binaries = []crashBinary{{Name: "herdrup", UUID: l.UUID}}
	}
	return report
}

// fitCrashReport is the report as JSON within the relay's limits: other
// goroutines go first, then the outer frames of the first, and the report
// says it was truncated.
func fitCrashReport(report crashReport) []byte {
	total := 0
	for i := range report.Stacks {
		total += len(report.Stacks[i].Frames)
	}
	for len(report.Stacks) > crashMaxStacks || (total > crashMaxFrames && len(report.Stacks) > 1) {
		total -= len(report.Stacks[len(report.Stacks)-1].Frames)
		report.Stacks = report.Stacks[:len(report.Stacks)-1]
		report.Truncated = true
	}
	for {
		body, err := json.Marshal(report)
		if err != nil {
			return nil
		}
		if len(body) <= crashMaxBytes {
			return body
		}
		report.Truncated = true
		if len(report.Stacks) > 1 {
			report.Stacks = report.Stacks[:len(report.Stacks)-1]
			continue
		}
		frames := report.Stacks[0].Frames
		report.Stacks[0].Frames = frames[:len(frames)/2]
	}
}

func randomToken(n int) string {
	raw := make([]byte, n)
	_, _ = rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}
