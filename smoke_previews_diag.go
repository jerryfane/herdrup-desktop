package main

// TEMPORARY diagnostic for issue #107 (draft PR, never merged): repeats the
// data-navigate preview case and logs how the frame's messages behave.

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/webpreview"
)

func diagDataNavigate(parent *mygo.Window, dir string) {
	type variant struct {
		delay   int
		channel string
		target  string
	}
	variants := []variant{
		{200, "parent", "data:text/html,<h1>ESCAPED POLICY</h1>"},
		{200, "top", "data:text/html,<h1>ESCAPED POLICY</h1>"},
		{1500, "parent", "data:text/html,<h1>ESCAPED POLICY</h1>"},
		{200, "parent", "about:blank#x"},
	}
	for round := 0; round < 3; round++ {
		for i, v := range variants {
			payload := fmt.Sprintf(`<!doctype html><p id="r">-</p><script>
const start=Date.now();let seq=0,nav=-1;
setInterval(()=>{seq++;const p={elapsed:Date.now()-start,seq,nav};document.getElementById("r").textContent=JSON.stringify(p);%s.postMessage({diag:p},"*")},80);
setTimeout(()=>{nav=Date.now()-start;location.href=%q},%d);</script>`, v.channel, v.target, v.delay)
			path := filepath.Join(dir, fmt.Sprintf("diag-%d-%d.html", round, i))
			if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
				log.Printf("smoke: diag107 write: %v", err)
				return
			}
			win, err := webpreview.Open(parent, path, "diag", true)
			if err != nil {
				log.Printf("smoke: diag107 open: %v", err)
				return
			}
			const probe = `(()=>{if(!window.__d){window.__d={n:0,last:null,afterNav:0};addEventListener("message",e=>{if(e.data?.diag){window.__d.n++;window.__d.last=e.data.diag;if(e.data.diag.nav>=0)window.__d.afterNav++}})}return JSON.stringify(window.__d)})()`
			_, _ = win.Page().Eval(probe)
			time.Sleep(time.Duration(v.delay)*time.Millisecond + 3*time.Second)
			got, err := win.Page().Eval(probe)
			log.Printf("smoke: diag107 round=%d delay=%d channel=%s target=%.20s -> %v err=%v", round, v.delay, v.channel, v.target, got, err)
			win.Close()
		}
	}
}
