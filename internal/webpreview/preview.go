// Package webpreview displays received HTML/SVG without granting it the app's
// origin or native bridge. The containing page is ours; only the sandboxed frame
// contains the received document. MyGo injects its bridge in the main frame only.
package webpreview

import (
	"fmt"
	"html"
	"os"
	"sync"

	"github.com/egoist/mygo"
)

// Match Swift's network-scheme rules and leave the inline document loadable.
// CSP covers WebSockets, which WebView2's request blocker does not see. Block
// data documents too, so navigating the frame cannot shed its CSP.
// Script-enabled previews can still signal via non-URL transports such as
// WebRTC; Settings warns about that, as the Swift app does.
const networkRules = `[
 {"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
 {"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},
 {"trigger":{"url-filter":"^ftps?://"},"action":{"type":"block"}},
 {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
 {"trigger":{"url-filter":"^blob:"},"action":{"type":"block"}},
 {"trigger":{"url-filter":"^data:","resource-type":["document"]},"action":{"type":"block"}}
]`

var rules = sync.OnceValues(func() (*mygo.ContentRules, error) {
	return mygo.CompileContentRules("herdrup-received-document", networkRules)
})

func document(content string, scripts bool) string {
	sandbox, scriptPolicy := "", "'none'"
	if scripts {
		sandbox, scriptPolicy = "allow-scripts", "'unsafe-inline'"
	}
	policy := "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; script-src " + scriptPolicy + "; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
	child := `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="` + policy + `">` + content
	return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:white;color:black}iframe{display:block;width:100%;height:100%;border:0;background:white}</style><iframe name="received-document" title="Document preview" sandbox="` + sandbox + `" referrerpolicy="no-referrer" srcdoc="` + html.EscapeString(child) + `"></iframe>`
}

// Open creates a child window only after its load blocker compiled. A failed
// blocker never falls back to opening the received document in a browser.
func Open(parent *mygo.Window, path, title string, scripts bool) (*mygo.Window, error) {
	blocker, err := rules()
	if err != nil {
		return nil, fmt.Errorf("preview protection unavailable: %w", err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: title, Width: 900, Height: 680, Parent: parent,
		Page: mygo.PageOptions{ContentRules: []*mygo.ContentRules{blocker}},
	})
	page := win.Page()
	page.SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	blockNavigation := func(event *mygo.NavigateEvent) {
		// WebKitGTK can report the frame's initial inline load as top-level.
		if event.URL != "about:srcdoc" {
			event.PreventDefault()
		}
	}
	page.OnWillNavigate(blockNavigation)
	page.OnWillFrameNavigate(blockNavigation)
	page.LoadHTML(document(string(content), scripts), "")
	return win, nil
}
