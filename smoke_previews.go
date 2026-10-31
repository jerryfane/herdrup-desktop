package main

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/webpreview"
)

// Run only in CI smoke builds. These checks need the real platform webview:
// string assertions about sandbox/CSP markup cannot prove its isolation.
func smokePreviews(parent *mygo.Window, capture string) error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	const image = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="black"/></svg>`
	var requests atomic.Int64
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "image/svg+xml")
		_, _ = w.Write([]byte(image))
	})}
	go server.Serve(listener)
	defer server.Close()
	base := "http://" + listener.Addr().String()
	control := mygo.NewWindow(mygo.WindowOptions{Title: "Preview network control", Width: 900, Height: 680, Parent: parent})
	control.Page().LoadHTML(`<img id="positive" src="`+base+`/positive">`, "")
	positive := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		v, err := control.Page().Eval(`document.getElementById("positive")?.naturalWidth === 12`)
		if err == nil && v == true && requests.Load() > 0 {
			positive = true
			break
		}
	}
	control.Close()
	if !positive {
		return fmt.Errorf("preview smoke: browser network positive control did not load")
	}
	dir, err := os.MkdirTemp("", "herdrup-preview-smoke-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	for _, mode := range []string{"off", "on", "navigate", "data-navigate"} {
		requests.Store(0)
		navigation := ""
		if mode == "navigate" {
			navigation = `setTimeout(()=>location.href="` + base + `/navigate",200);`
		} else if mode == "data-navigate" {
			navigation = `setTimeout(()=>location.href="data:text/html,<h1>ESCAPED POLICY</h1>",200);`
		}
		payload := `<!doctype html><h1>Received preview: ` + mode + `</h1><p id="result">SCRIPTS DISABLED</p><p>Inline content remains visible.</p><style>body{font:20px sans-serif}#result{overflow-wrap:anywhere}</style><img src="data:image/svg+xml;base64,` + base64.StdEncoding.EncodeToString([]byte(image)) + `"><img src="` + base + `/passive"><script>
const start=Date.now();let parentAccess="blocked",storage="blocked";
try{parentAccess=parent.document.title}catch{}try{storage=localStorage.length}catch{}
const proof={bridge:typeof window.mygo,parentAccess,storage,fetch:"pending",websocket:"pending",popup:window.open("` + base + `/popup")===null};
fetch("` + base + `/fetch").then(()=>proof.fetch="allowed",()=>proof.fetch="blocked");
try{const ws=new WebSocket("` + strings.Replace(base, "http://", "ws://", 1) + `/socket");ws.onopen=()=>proof.websocket="allowed";ws.onerror=()=>proof.websocket="blocked"}catch{proof.websocket="blocked"}
setInterval(()=>{proof.elapsed=Date.now()-start;proof.inlineImage=document.images[0].naturalWidth;document.getElementById("result").textContent=JSON.stringify(proof);parent.postMessage({previewProof:proof},"*")},80);` + navigation + `</script>`
		path := filepath.Join(dir, mode+".html")
		if err = os.WriteFile(path, []byte(payload), 0o600); err != nil {
			return err
		}
		win, err := webpreview.Open(parent, path, "Preview smoke: "+mode, mode != "off")
		if err != nil {
			return err
		}
		err = smokePreviewFrame(win, mode)
		if png, captureErr := win.CapturePage(); captureErr == nil {
			captureErr = os.WriteFile(capture+"-preview-"+mode+".png", png, 0o600)
			if err == nil {
				err = captureErr
			}
		} else if err == nil {
			err = captureErr
		}
		win.Close()
		if err != nil {
			return err
		}
		if requests.Load() != 0 {
			return fmt.Errorf("preview smoke %s: received %d forbidden network requests", mode, requests.Load())
		}
	}
	return nil
}

func smokePreviewFrame(win *mygo.Window, mode string) error {
	const probe = `(()=>{if(!window.__previewListening){window.__previewListening=true;addEventListener("message",e=>{if(e.data?.previewProof)window.__previewProof=e.data.previewProof})}const f=document.querySelector("iframe");return {frame:!!f,opaque:f?.contentDocument===null,proof:window.__previewProof??null}})()`
	started := time.Now()
	var last any
	for time.Since(started) < 5*time.Second {
		value, err := win.Page().Eval(probe)
		if err != nil {
			return err
		}
		last = value
		if state, ok := value.(map[string]any); ok && state["frame"] == true && state["opaque"] == true {
			if mode == "off" {
				if state["proof"] != nil {
					return fmt.Errorf("preview smoke: script ran with preference off: %v", state)
				}
				if time.Since(started) >= time.Second {
					return nil
				}
			} else if p, ok := state["proof"].(map[string]any); ok {
				elapsed, _ := p["elapsed"].(float64)
				if elapsed >= 1000 && p["bridge"] == "undefined" && p["parentAccess"] == "blocked" && p["storage"] == "blocked" && p["fetch"] == "blocked" && p["websocket"] == "blocked" && p["popup"] == true && p["inlineImage"] == float64(12) {
					return nil
				}
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("preview smoke %s: rendering/isolation check failed: %v", mode, last)
}
