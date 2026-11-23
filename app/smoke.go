package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// smoke is set to "1" only by CI (MYGO_LDFLAGS="-X main.smoke=1"). Release
// builds have no smoke mode.
var smoke string

func smokeEnabled() bool { return smoke == "1" }

// Capture failures before the application's module starts. An empty board alone
// cannot distinguish a failed module load from a connected but empty roster.
func smokePreload() string {
	if !smokeEnabled() {
		return ""
	}
	// HERDRUP_STAR_PROMPT=1 is the explicit test flag that lets a smoke or reference
	// run show the GitHub star ask, which captures otherwise hide (src/starPrompt.ts).
	star := ""
	if os.Getenv("HERDRUP_STAR_PROMPT") == "1" {
		star = "globalThis.herdrupStarPrompt = true;\n"
	}
	return star + `window.__herdrupSmokeErrors = [];
const record = value => window.__herdrupSmokeErrors.push(String(value));
window.addEventListener("error", event => record(event.error?.stack || event.message || event.target?.src || event.target?.href || "resource error"), true);
window.addEventListener("unhandledrejection", event => record(event.reason?.stack || event.reason));
window.__herdrupSmokeLoad = [];
const loadEvent = event => window.__herdrupSmokeLoad.push({event:event.type, at:performance.now(), ready:document.readyState});
document.addEventListener("readystatechange", loadEvent);
document.addEventListener("DOMContentLoaded", loadEvent);
window.addEventListener("load", loadEvent);`
}

const smokePageProbe = `({
 rows: document.querySelectorAll(".row").length,
 text: document.body?.innerText.slice(0,300), errors: window.__herdrupSmokeErrors,
 scripts: Array.from(document.scripts, script => script.src),
 ready: document.readyState, href: location.href, at: performance.now(),
 visibility: document.visibilityState, fonts: document.fonts.status,
 events: window.__herdrupSmokeLoad,
 resources: performance.getEntriesByType("resource").map(r => ({name:r.name,duration:r.duration,responseEnd:r.responseEnd,bytes:r.encodedBodySize}))
})`

// runSmoke connects to the machine named by HERDRUP_SMOKE_* variables,
// waits for a board with agents, saves a screenshot of the window to
// HERDRUP_SMOKE_CAPTURE and quits. It exits 1 when no agent was shown. A
// Windows GUI program has no stderr, so it logs to HERDRUP_SMOKE_LOG.
func runSmoke(desk *Desk, win *mygo.Window) {
	if path := os.Getenv("HERDRUP_SMOKE_LOG"); path != "" {
		if f, err := os.Create(path); err == nil {
			log.SetOutput(f)
		}
	}
	// HERDRUP_SMOKE_PHONE=1: the page starts at a phone's width (RoverOS's 360x780), so
	// its first layout is the phone layout (style.css, at 700 px and narrower). Sized
	// here, before the page has laid out; a full-screen window can't be relied on to
	// fill a CI display, which has no window manager.
	if os.Getenv("HERDRUP_SMOKE_PHONE") == "1" {
		win.SetContentSize(360, 780)
	}
	win.Page().OnDOMReady(func() { log.Print("smoke: native DOM ready") })
	// The page's own deadline runs from its load: the webview can start
	// long after the board reaches Go (WebView2 on hosted Windows took 2 s,
	// 24 s and 56 s in three runs on 2026-11-02), which the overall 90 s
	// limit already bounds.
	loaded := make(chan struct{})
	var loadedOnce sync.Once
	win.Page().OnDidFinishLoad(func() {
		log.Print("smoke: native load finished")
		loadedOnce.Do(func() { close(loaded) })
	})
	win.Page().OnDidFailLoad(func(err *mygo.LoadError) { log.Printf("smoke: native load failed: %+v", err) })
	go func() {
		var last ConnState
		for range time.Tick(200 * time.Millisecond) {
			if s := desk.State(); s != last {
				log.Printf("smoke: state %+v", s)
				last = s
			}
		}
	}()
	// HERDRUP_SMOKE_FIRSTRUN=1: a first launch with no machine (RoverOS's first boot). The
	// page must reach a working host screen ("connect to your machine") with no startup
	// error, caught or not; nothing is connected. The deadline armed at launch
	// (armFirstRunDeadline) bounds the load, every probe and the exit.
	if os.Getenv("HERDRUP_SMOKE_FIRSTRUN") == "1" {
		go smokeFirstRun(win, loaded, os.Getenv("HERDRUP_SMOKE_CAPTURE"), firstRunDeadline, os.Getenv("HERDRUP_SMOKE_PHONE") == "1")
		return
	}
	port, _ := strconv.Atoi(os.Getenv("HERDRUP_SMOKE_PORT"))
	m := Machine{
		Host:    os.Getenv("HERDRUP_SMOKE_HOST"),
		Port:    port,
		User:    os.Getenv("HERDRUP_SMOKE_USER"),
		KeyPath: os.Getenv("HERDRUP_SMOKE_KEY"),
	}
	out := os.Getenv("HERDRUP_SMOKE_CAPTURE")
	var once sync.Once
	finish := func(ok bool, why string) {
		once.Do(func() {
			png, err := win.CapturePage()
			if err != nil {
				log.Printf("smoke: capture: %v", err)
				ok = false
			} else if err := os.WriteFile(out, png, 0o644); err != nil {
				log.Printf("smoke: write capture: %v", err)
				ok = false
			}
			log.Printf("smoke: %s (state %+v)", why, desk.State())
			if !ok {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				after, probeErr := win.Page().EvalContext(ctx, smokePageProbe)
				cancel()
				log.Printf("smoke: after failure capture: state=%v error=%v", after, probeErr)
				os.Exit(1)
			}
			mygo.App.Quit()
		})
	}
	// The board reaching Go is not the page showing it: wait until the
	// page has drawn a row for every agent in the open sections.
	pageShows := func(want int) {
		<-loaded
		var last any
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
			v, err := win.Page().Eval(smokePageProbe)
			if err != nil {
				last = err
				continue
			}
			last = v
			if m, ok := v.(map[string]any); ok {
				if n, _ := m["rows"].(float64); int(n) == want {
					if captured, valid := m["errors"].([]any); valid && len(captured) > 0 {
						finish(false, "uncaught startup errors: "+fmt.Sprint(captured))
						return
					}
					// HERDRUP_SMOKE_PHONE=1 (CI's Linux smoke, second launch): the page
					// started in the phone layout, as RoverOS starts it. Its roster drawn
					// without startup errors is the check; the typing and invitation steps
					// below are the desktop layout's.
					if os.Getenv("HERDRUP_SMOKE_PHONE") == "1" {
						width, _ := win.Page().Eval(`innerWidth`)
						time.Sleep(500 * time.Millisecond)
						finish(true, fmt.Sprintf("phone layout (%v px wide): page shows %d rows", width, want))
						return
					}
					// Let the browser paint the frame it just laid out.
					time.Sleep(500 * time.Millisecond)
					if err := smokeTyping(win, out); err != nil {
						finish(false, err.Error())
						return
					}
					if err := smokeGuestInvite(desk, win, out); err != nil {
						finish(false, err.Error())
						return
					}
					finish(true, "page shows "+strconv.Itoa(want)+" rows; preview isolation, predictive typing and guest invitations passed")
					return
				}
			}
		}
		log.Printf("smoke: page never showed %d rows; last probe: %v", want, last)
		finish(false, "page did not render the board")
	}
	var started sync.Once
	desk.mu.Lock()
	desk.onBoard = func(b BoardUpdate) {
		visible := 0
		for _, s := range b.Board.Sections {
			if !s.Collapsed {
				visible += len(s.Rows)
			}
		}
		if visible > 0 {
			started.Do(func() { go pageShows(visible) })
		}
	}
	desk.mu.Unlock()
	if err := desk.Connect(m, ""); err != nil {
		log.Printf("smoke: connect: %v", err)
		go finish(false, "connect failed")
		return
	}
	time.AfterFunc(90*time.Second, func() { finish(false, "timed out without a board") })
}

// firstRunDeadline is the first-run smoke's one deadline (armFirstRunDeadline).
var firstRunDeadline time.Time

// armFirstRunDeadline starts the first-run smoke's deadline at launch, before
// the window is made, navigated or sized: a stall in any of those, as in the
// page's load and probes, fails the run instead of waiting for the CI job's
// timeout. A hard exit 10 s after it covers capture and quit.
func armFirstRunDeadline() {
	if !smokeEnabled() || os.Getenv("HERDRUP_SMOKE_FIRSTRUN") != "1" {
		return
	}
	firstRunDeadline = time.Now().Add(90 * time.Second)
	time.AfterFunc(time.Until(firstRunDeadline)+10*time.Second, func() {
		log.Print("smoke: first run: still running past its deadline")
		os.Exit(1)
	})
}

// smokeFirstRunProbe reads whether the page shows the host screen (render adds
// host-home-visible to the body) and how many of its host actions (Add host,
// Scan pairing code) a click would reach: visible, inside the window, and not
// covered (the hit test at its centre lands on it). The account welcome of a
// first launch is dismissed first ("Set up without an account"), as a person
// would. phone is the stylesheet's own phone-layout marker; width is for the log.
const smokeFirstRunProbe = `(() => {
 const welcome = document.querySelector(".account-welcome");
 const welcomed = !!welcome && !welcome.hidden;
 if (welcomed) document.querySelector(".account-welcome-skip")?.click();
 const reachable = e => {
  const r = e.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.left < -1 || r.right > innerWidth + 1 || getComputedStyle(e).visibility === "hidden") return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === e || e.contains(hit));
 };
 const connect = document.getElementById("connect");
 const actions = connect && !connect.hidden ? Array.from(connect.querySelectorAll(".host-add, .host-pair")).filter(reachable).length : 0;
 return {
  hostHome: document.body?.classList.contains("host-home-visible") === true,
  welcome: welcomed, actions, width: innerWidth,
  phone: getComputedStyle(document.documentElement).getPropertyValue("--phone-layout").trim() === "1",
  text: document.body?.innerText.slice(0,300), errors: window.__herdrupSmokeErrors,
 };
})()`

// firstRunVerdict judges one probe: done with ok when the host screen works
// (shown, a host action a click reaches, in the phone layout when phone is
// asked) and no error was reported or caught; done and failed on any error;
// not done otherwise (still loading, or the welcome was just dismissed).
func firstRunVerdict(probe map[string]any, reported int64, phone bool) (done, ok bool, why string) {
	if errs, _ := probe["errors"].([]any); len(errs) > 0 {
		return true, false, "uncaught startup errors: " + fmt.Sprint(errs)
	}
	if reported > 0 {
		return true, false, fmt.Sprintf("the page reported %d error(s); see \"page error\" above", reported)
	}
	home, _ := probe["hostHome"].(bool)
	welcome, _ := probe["welcome"].(bool)
	actions, _ := probe["actions"].(float64)
	if !home || welcome || actions < 1 {
		return false, false, ""
	}
	width, _ := probe["width"].(float64)
	if inPhone, _ := probe["phone"].(bool); phone && !inPhone {
		return true, false, fmt.Sprintf("the host screen shows at %v px, not in the phone layout", width)
	}
	return true, true, fmt.Sprintf("the host screen shows with %v host actions at %v px", actions, width)
}

// smokeFirstRun passes once the page shows a working host screen with no
// startup error, and fails on an error or when the screen hasn't come by deadline.
func smokeFirstRun(win *mygo.Window, loaded <-chan struct{}, out string, deadline time.Time, phone bool) {
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	end := func(ok bool, why string) {
		if png, err := win.CapturePage(); err == nil && out != "" {
			_ = os.WriteFile(out, png, 0o644)
		}
		log.Printf("smoke: first run: %s", why)
		if !ok {
			os.Exit(1)
		}
		mygo.App.Quit()
	}
	select {
	case <-loaded:
	case <-ctx.Done():
		end(false, "the page never loaded")
		return
	}
	var last any
	for ctx.Err() == nil {
		v, err := win.Page().EvalContext(ctx, smokeFirstRunProbe)
		if err != nil {
			last = err
		} else {
			last = v
			m, _ := v.(map[string]any)
			if done, ok, why := firstRunVerdict(m, pageErrors.Load(), phone); done {
				if ok {
					// Let the browser paint the frame, then check nothing was reported meanwhile.
					time.Sleep(500 * time.Millisecond)
					if n := pageErrors.Load(); n > 0 {
						ok, why = false, fmt.Sprintf("the page reported %d error(s); see \"page error\" above", n)
					}
				}
				end(ok, why)
				return
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(250 * time.Millisecond):
		}
	}
	end(false, fmt.Sprintf("the host screen never showed; last probe: %v", last))
}
