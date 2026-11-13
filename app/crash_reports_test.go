package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// newTestCrashReporter is a reporter in a temp dir whose switch is on, sending to url.
func newTestCrashReporter(t *testing.T, dir, url string) *crashReporter {
	t.Helper()
	usage := newUsagePing(filepath.Join(dir, "usage-ping.json"), "desktop-linux", "0.1.0-test")
	r := newCrashReporter(filepath.Join(dir, "crash-reports"), usage, "0.1.0-test")
	r.url = url
	return r
}

func queuedReports(t *testing.T, r *crashReporter) []crashReport {
	t.Helper()
	entries, _ := os.ReadDir(r.queueDir())
	var reports []crashReport
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(r.queueDir(), e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var report crashReport
		if err := json.Unmarshal(data, &report); err != nil {
			t.Fatal(err)
		}
		reports = append(reports, report)
	}
	return reports
}

// TestCrashChildProcess is the crashing launch of
// TestAGoCrashIsReportedOnTheNextLaunch; it runs only as that child.
func TestCrashChildProcess(t *testing.T) {
	dir := os.Getenv("HERDRUP_CRASH_CHILD_DIR")
	if dir == "" {
		t.Skip("the crashing child of TestAGoCrashIsReportedOnTheNextLaunch")
	}
	r := newTestCrashReporter(t, dir, "http://127.0.0.1:1/")
	r.arm()
	done := make(chan struct{})
	go crashTestPanic(done)
	<-done
}

//go:noinline
func crashTestPanic(chan struct{}) {
	panic("agent secret-agent-name wrote: secret prompt text")
}

// The relay's patterns (GuestRelay/src/crash.ts).
var (
	relayVersion = regexp.MustCompile(`^[0-9A-Za-z._-]{1,32}$`)
	relayDevice  = regexp.MustCompile(`^[0-9A-Za-z,._-]{1,32}$`)
	relayUUID    = regexp.MustCompile(`^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$`)
)

// herdrup #671 on Desktop: a Go panic in one launch is sent on the next as the
// relay's report: how it ended and the stacks as offsets in the executable,
// never the panic's text.
func TestAGoCrashIsReportedOnTheNextLaunch(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads the image base from /proc/self/maps")
	}
	dir := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestCrashChildProcess$")
	child.Env = append(os.Environ(), "HERDRUP_CRASH_CHILD_DIR="+dir)
	if out, err := child.CombinedOutput(); err == nil || !strings.Contains(string(out), "secret prompt text") {
		t.Fatalf("the child did not panic: %v\n%s", err, out)
	}
	r := newTestCrashReporter(t, dir, "http://127.0.0.1:1/")
	r.collect()
	if raw, _ := filepath.Glob(filepath.Join(r.dir, "launch-*")); len(raw) != 0 {
		t.Fatalf("the crash file outlived its report: %v", raw)
	}
	reports := queuedReports(t, r)
	if len(reports) != 1 {
		t.Fatalf("%d reports, want 1", len(reports))
	}
	report := reports[0]
	body, _ := json.Marshal(report)
	if strings.Contains(string(body), "secret") {
		t.Fatalf("the report carries the panic's text: %s", body)
	}
	if report.Kind != "crash" || report.Termination != "go panic" || !relayVersion.MatchString(report.Version) ||
		!relayVersion.MatchString(report.Build) || !relayDevice.MatchString(report.Device) {
		t.Fatalf("report %s", body)
	}
	if len(report.Binaries) != 1 || !relayUUID.MatchString(report.Binaries[0].UUID) || len(report.Stacks) == 0 || !report.Stacks[0].Attributed {
		t.Fatalf("binaries/stacks %s", body)
	}
	// The test binary is not position-independent, so its image loads where the
	// child's did: the offsets name the child's functions here.
	base, ok := imageBase()
	if !ok {
		t.Fatal("no image base")
	}
	var names []string
	for _, f := range report.Stacks[0].Frames {
		if fn := runtime.FuncForPC(base + uintptr(f[1]) - 1); fn != nil {
			names = append(names, fn.Name())
		}
	}
	if !strings.Contains(strings.Join(names, " "), ".crashTestPanic ") {
		t.Fatalf("the panicking goroutine's frames are %v", names)
	}
}

// Off, nothing is kept or sent: the switch deletes the crash files and the
// queue, and a dying web view is not reported.
func TestCrashReportsFollowTheUsageSwitch(t *testing.T) {
	dir := t.TempDir()
	r := newTestCrashReporter(t, dir, "http://127.0.0.1:1/")
	r.renderGone("crashed")
	waitFor(t, "the report to be tried", func() bool { r.mu.Lock(); defer r.mu.Unlock(); return !r.sending })
	if got := queuedReports(t, r); len(got) != 1 || got[0].Termination != "webview process crashed" || len(got[0].Stacks) != 0 {
		t.Fatalf("on: %+v", got)
	}
	if err := r.usage.setEnabled(false); err != nil {
		t.Fatal(err)
	}
	r.setEnabled(false)
	if _, err := os.Stat(r.dir); !os.IsNotExist(err) {
		t.Fatalf("off kept %s: %v", r.dir, err)
	}
	r.renderGone("crashed")
	r.start()
	if _, err := os.Stat(r.dir); !os.IsNotExist(err) {
		t.Fatalf("off wrote %s: %v", r.dir, err)
	}
}

// At most five a UTC day; a refused report (4xx) is dropped, one the relay
// could not take now (429, 5xx) waits.
func TestCrashReportsSendFiveADayAndKeepWhatTheRelayCouldNotTake(t *testing.T) {
	var mu sync.Mutex
	statuses := []int{}
	answer := http.StatusNoContent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		statuses = append(statuses, answer)
		w.WriteHeader(answer)
	}))
	defer srv.Close()
	r := newTestCrashReporter(t, t.TempDir(), srv.URL)
	day := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	r.now = func() time.Time { day = day.Add(time.Millisecond); return day }
	r.mu.Lock()
	for i := range 8 {
		r.enqueueLocked(crashReport{V: 1, Kind: "crash", Version: "1", Build: "b", OS: "linux", Device: "linux-amd64",
			Termination: fmt.Sprintf("go panic %d", i), Binaries: []crashBinary{}, Stacks: []crashStack{}})
	}
	r.mu.Unlock()
	r.send()
	if left := len(queuedReports(t, r)); len(statuses) != 5 || left != 3 {
		t.Fatalf("sent %d, %d left; want 5 sent, 3 left", len(statuses), left)
	}
	day = day.Add(24 * time.Hour)
	answer = http.StatusServiceUnavailable
	r.send()
	if left := len(queuedReports(t, r)); left != 3 {
		t.Fatalf("a 503 dropped a report: %d left", left)
	}
	answer = http.StatusBadRequest
	r.send()
	if left := len(queuedReports(t, r)); left != 0 {
		t.Fatalf("refused reports stayed: %d left", left)
	}
}

// A crash with every goroutine's stack still fits the relay's 64 KB: other
// goroutines go first and the report says it was cut.
func TestABigCrashFitsTheRelayLimit(t *testing.T) {
	var b strings.Builder
	b.WriteString("panic: boom\n\n")
	for g := range 400 {
		fmt.Fprintf(&b, "goroutine %d gp=0x1 m=nil [select]:\n", g+1)
		for f := range 100 {
			fmt.Fprintf(&b, "main.f%d()\n\t/src/x.go:%d +0x1d fp=0x1 sp=0x2 pc=0x%x\n", f, f, 0x401000+g*1000+f)
		}
	}
	report := crashFromOutput(b.String(), crashLaunch{Version: "1", Build: "b", OS: "linux", Device: "linux-amd64",
		Base: 0x400000, UUID: "00000000-0000-0000-0000-000000000000"})
	if len(report.Stacks) != 400 {
		t.Fatalf("%d stacks parsed, want 400", len(report.Stacks))
	}
	body := fitCrashReport(report)
	var fitted crashReport
	if err := json.Unmarshal(body, &fitted); err != nil {
		t.Fatal(err)
	}
	if len(body) > crashMaxBytes || !fitted.Truncated || !fitted.Stacks[0].Attributed || len(fitted.Stacks[0].Frames) != 100 {
		t.Fatalf("%d bytes, truncated %v, %d stacks", len(body), fitted.Truncated, len(fitted.Stacks))
	}
}
