package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// refExpand is, for each state of herdrup's agent-list references
// (design/reference/agent-list in herdrup), the closed sections the page
// opens before the capture.
var refExpand = map[string][]string{
	"loading":                      nil,
	"empty":                        nil,
	"populated":                    nil,
	"idle-expanded":                {"idle"},
	"archived-expanded":            {"archived"},
	"all-expanded":                 {"idle", "archived"},
	"folders":                      {"folder:herdr"},
	"avatars":                      nil,
	"sessions":                     nil,
	"federated":                    nil,
	"needs-you-pill":               nil,
	"needs-you-rail":               nil,
	"gram-mixed-latest":            nil,
	"gram-mixed-image":             nil,
	"gram-mixed-folded":            nil,
	"gram-mixed-code":              nil,
	"gram-saved":                   nil,
	"gram-search-results":          nil,
	"gram-search-empty":            nil,
	"gram-composer-attachment":     nil,
	"gram-composer-ambiguous":      nil,
	"gram-empty":                   nil,
	"gram-loading":                 nil,
	"settings-machines-index":      nil,
	"settings-machines-federation": nil,
	"settings-machines-empty":      nil,
	"settings-about-index":         nil,
	"detail-chat":                  nil,
	"detail-terminal":              nil,
	"detail-writer-collapsed":      nil,
	"detail-writer-expanded":       nil,
	"detail-host-selection":        nil,
}

// refEnabled reports whether this run is a reference capture: a smoke
// build (main.smoke=1) started with HERDRUP_REF_STATE.
func refEnabled() bool { return smokeEnabled() && os.Getenv("HERDRUP_REF_STATE") != "" }

// Reference timestamps are absolute. Freeze wall time only in a reference run;
// timers and performance.now keep advancing so the real asynchronous UI settles.
func refPreload() string {
	if !refEnabled() {
		return ""
	}
	return `;(() => { const NativeDate = Date; const now = 1793180460000;
globalThis.Date = class extends NativeDate {
  constructor(...args) { if (args.length) super(...args); else super(now); }
  static now() { return now; }
}; })();`
}

// refTiming bounds the waits of a reference capture. Total stays under
// the bridge's 60 s call timeout, after which the loading state turns
// into an error.
type refTiming struct {
	total time.Duration // until the state is drawn
	hook  time.Duration // until window.herdrupRef exists, once the page answers
}

// runRef draws one reference state for the parity workflow
// (.github/workflows/parity.yml): it sizes the window's page area to
// HERDRUP_REF_SIZE points ("1180x788"), connects to the machine named by
// the HERDRUP_SMOKE_* variables (a cmd/fakeherdr in the state's mode),
// waits for window.herdrupRef.ready(), opens the state's sections, waits
// again, saves the page to HERDRUP_REF_CAPTURE, and quits. With
// HERDRUP_REF_SCALE (e.g. "2") the page renders at that many pixels per
// point whatever the display's (macOS only, see refDeviceScale). What it
// saw (sizes, scales, outcome) goes to HERDRUP_REF_CAPTURE + ".json". It
// exits 1 when the state was not drawn in time, after saving the page as
// it was.
func runRef(desk *Desk, win *mygo.Window) {
	if path := os.Getenv("HERDRUP_SMOKE_LOG"); path != "" {
		if f, err := os.Create(path); err == nil {
			log.SetOutput(f)
		}
	}
	state := os.Getenv("HERDRUP_REF_STATE")
	out := os.Getenv("HERDRUP_REF_CAPTURE")
	expand, known := refExpand[state]
	w, h, sizeErr := parseRefSize(os.Getenv("HERDRUP_REF_SIZE"))
	switch {
	case !known:
		log.Printf("ref: unknown HERDRUP_REF_STATE %q", state)
		os.Exit(1)
	case sizeErr != nil:
		log.Printf("ref: HERDRUP_REF_SIZE: %v", sizeErr)
		os.Exit(1)
	case out == "":
		log.Printf("ref: HERDRUP_REF_CAPTURE is not set")
		os.Exit(1)
	}
	var scale float64
	if s := os.Getenv("HERDRUP_REF_SCALE"); s != "" {
		var err error
		if scale, err = strconv.ParseFloat(s, 64); err != nil || scale <= 0 {
			log.Printf("ref: HERDRUP_REF_SCALE %q is not a positive number", s)
			os.Exit(1)
		}
	}
	t := refTiming{total: 45 * time.Second, hook: 15 * time.Second}
	if s := os.Getenv("HERDRUP_REF_TIMEOUT"); s != "" {
		d, err := time.ParseDuration(s)
		if err != nil {
			log.Printf("ref: HERDRUP_REF_TIMEOUT: %v", err)
			os.Exit(1)
		}
		t.total = d
	}
	cleanup, err := prepareGramReference(desk, state)
	if err != nil {
		log.Printf("ref: prepare Gram: %v", err)
		os.Exit(1)
	}
	placeRefWindow(win, w, h)
	rep := refReport{State: state, Want: [2]int{w, h}}
	if rep.BackingScale, rep.ScaleOverride, err = refDeviceScale(win, scale); err != nil {
		rep.Outcome = "device scale: " + err.Error()
		cleanup()
		go finishRef(win, out, &rep, false)
		return
	}

	port, _ := strconv.Atoi(os.Getenv("HERDRUP_SMOKE_PORT"))
	m := Machine{
		Host:    os.Getenv("HERDRUP_SMOKE_HOST"),
		Port:    port,
		User:    os.Getenv("HERDRUP_SMOKE_USER"),
		KeyPath: os.Getenv("HERDRUP_SMOKE_KEY"),
	}
	if strings.HasPrefix(state, "settings-") {
		// Native DesktopReferenceMock's configured home-box display name.
		m.Nickname = "reference-hub"
	}
	if state != "detail-host-selection" {
		if err := desk.Connect(m, ""); err != nil {
			rep.Outcome = "connect: " + err.Error()
			cleanup()
			go finishRef(win, out, &rep, false)
			return
		}
	}
	go func() {
		var ok bool
		var why string
		if state == "detail-host-selection" {
			ok, why = waitReferenceHosts(win, w, h, t.total)
		} else {
			ok, why = driveRef(win, w, h, expand, t)
		}
		if ok {
			ok, why = driveBoardReference(win, state)
		}
		if ok {
			ok, why = driveGramReference(desk, win, state)
		}
		if ok {
			ok, why = driveSettingsReference(win, state)
		}
		if ok {
			ok, why = driveDetailReference(win, state)
		}
		rep.Outcome = why
		cleanup()
		finishRef(win, out, &rep, ok)
	}()
}

// parseRefSize reads "WxH" in points.
func parseRefSize(s string) (w, h int, err error) {
	ws, hs, ok := strings.Cut(s, "x")
	if ok {
		w, err = strconv.Atoi(ws)
		if err == nil {
			h, err = strconv.Atoi(hs)
		}
	}
	if !ok || err != nil || w <= 0 || h <= 0 {
		return 0, 0, fmt.Errorf("%q is not WIDTHxHEIGHT in points", s)
	}
	return w, h, nil
}

// placeRefWindow sizes the page area to w×h points and moves the window
// to the top-left of the primary display's work area. GitHub's macOS
// runners have a 1024×768 pt display, smaller than the references.
// AppKit fits a resizable window's height into the screen, and only a
// resizable one's (NSWindow constrainFrameRect:toScreen:), so the window
// is made fixed-size and runs past the screen's bottom instead.
func placeRefWindow(win *mygo.Window, w, h int) {
	win.SetResizable(false)
	wa := mygo.Screen.PrimaryDisplay().WorkArea
	win.SetPosition(wa.X, wa.Y)
	win.SetContentSize(w, h)
}

// driveRef waits for the page to draw its state, opens the sections, and
// waits again. It reports whether the state was drawn and how it ended.
func driveRef(win *mygo.Window, w, h int, expand []string, t refTiming) (bool, string) {
	deadline := time.Now().Add(t.total)
	// The system may move or resize the window as it shows it: once the
	// page answers, put the window back.
	for ; time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if _, err := win.Page().Eval(`return true`); err == nil {
			break
		}
	}
	if cw, ch := win.ContentSize(); cw != w || ch != h {
		log.Printf("ref: page area %dx%d pt once shown; setting %dx%d again", cw, ch, w, h)
		placeRefWindow(win, w, h)
	}
	if ok, why := waitRefReady(win, deadline, t.hook); !ok {
		return false, why
	}
	if len(expand) > 0 {
		keys, _ := json.Marshal(expand)
		// Two frames, so ready() describes the page after the change.
		js := `const ref = window.herdrupRef; for (const k of ` + string(keys) + `) ref.expand(k, true); ` +
			`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true`
		if _, err := win.Page().Eval(js); err != nil {
			return false, "expand " + strings.Join(expand, "+") + ": " + err.Error()
		}
		if ok, why := waitRefReady(win, deadline, t.hook); !ok {
			return false, "after expand " + strings.Join(expand, "+") + ": " + why
		}
	}
	// Let the browser paint the frame it laid out.
	_, _ = win.Page().Eval(`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true`)
	time.Sleep(300 * time.Millisecond)
	return true, "ready"
}

// waitRefReady polls window.herdrupRef.ready() until it is true or the
// deadline passes. A page that answers but has no herdrupRef for hookWait
// fails early.
func waitRefReady(win *mygo.Window, deadline time.Time, hookWait time.Duration) (bool, string) {
	const probe = `const ref = window.herdrupRef; ` +
		`return {hook: typeof ref?.ready === "function", ready: typeof ref?.ready === "function" && ref.ready() === true}`
	var answered time.Time
	var last any
	for ; time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		v, err := win.Page().Eval(probe)
		if err != nil {
			last = err
			continue
		}
		last = v
		if answered.IsZero() {
			answered = time.Now()
		}
		r, _ := v.(map[string]any)
		if ready, _ := r["ready"].(bool); ready {
			return true, "ready"
		}
		if hook, _ := r["hook"].(bool); !hook && time.Since(answered) > hookWait {
			return false, fmt.Sprintf("the page has no window.herdrupRef after %s", hookWait)
		}
	}
	return false, fmt.Sprintf("herdrupRef.ready() not true in time; last probe: %v", last)
}

// refReport is the sidecar of a capture: what was asked, what the window
// and display were, and how it ended.
type refReport struct {
	State string `json:"state"`
	// Want is the page area asked for, in points.
	Want [2]int `json:"wantPt"`
	// ContentPt is the window's page area as mygo reports it.
	ContentPt [2]int `json:"contentPt"`
	// Inner and DevicePixelRatio are what the page sees.
	Inner            [2]float64 `json:"innerPt"`
	DevicePixelRatio float64    `json:"devicePixelRatio"`
	// CapturePx is the PNG's size; CaptureScale is its width over Want's.
	CapturePx    [2]int  `json:"capturePx"`
	CaptureScale float64 `json:"captureScale"`
	// BackingScale is the window's display scale (NSWindow
	// backingScaleFactor); ScaleOverride the web view's forced device
	// scale, 0 for none.
	BackingScale  float64        `json:"backingScale"`
	ScaleOverride float64        `json:"scaleOverride"`
	Displays      []mygo.Display `json:"displays"`
	Outcome       string         `json:"outcome"`
	OK            bool           `json:"ok"`
}

var refOnce sync.Once

// finishRef saves the page and the sidecar, then quits, with status 1
// when ok is false or anything could not be saved.
func finishRef(win *mygo.Window, out string, rep *refReport, ok bool) {
	refOnce.Do(func() {
		rep.ContentPt[0], rep.ContentPt[1] = win.ContentSize()
		rep.Displays = mygo.Screen.Displays()
		// The display the window ended up on, now that it is shown.
		if backing, _, err := refDeviceScale(win, 0); err == nil {
			rep.BackingScale = backing
		}
		if v, err := win.Page().Eval(`return [innerWidth, innerHeight, devicePixelRatio]`); err == nil {
			if a, _ := v.([]any); len(a) == 3 {
				rep.Inner[0], _ = a[0].(float64)
				rep.Inner[1], _ = a[1].(float64)
				rep.DevicePixelRatio, _ = a[2].(float64)
			}
		}
		png, err := win.CapturePage()
		if err == nil {
			err = os.WriteFile(out, png, 0o644)
		}
		if err != nil {
			ok = false
			rep.Outcome += "; capture: " + err.Error()
		} else if cfg, _, err := image.DecodeConfig(bytes.NewReader(png)); err == nil {
			rep.CapturePx = [2]int{cfg.Width, cfg.Height}
			rep.CaptureScale = float64(cfg.Width) / float64(rep.Want[0])
		}
		if rep.ContentPt != rep.Want {
			ok = false
			rep.Outcome += fmt.Sprintf("; page area is %dx%d pt, not %dx%d", rep.ContentPt[0], rep.ContentPt[1], rep.Want[0], rep.Want[1])
		}
		rep.OK = ok
		data, _ := json.MarshalIndent(rep, "", "  ")
		if err := os.WriteFile(out+".json", append(data, '\n'), 0o644); err != nil {
			log.Printf("ref: %v", err)
			ok = false
		}
		log.Printf("ref: %s", data)
		if !ok {
			os.Exit(1)
		}
		mygo.App.Quit()
	})
}
