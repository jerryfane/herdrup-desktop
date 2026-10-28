//go:build darwin

package main

import (
	"errors"
	"fmt"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

var (
	msgFloat    func(id objc.ID, sel objc.SEL) float64
	msgSetFloat func(id objc.ID, sel objc.SEL, v float64)
)

// refDeviceScale reports the window's backing scale (pixels per point of
// its display) and, when scale > 0, makes the web view render at scale
// pixels per point whatever the display's. WKWebView's snapshot (what
// Window.CapturePage takes) is drawn at the web view's device scale, so a
// 1x display then still gives a capture at the references' 2x. It uses
// WebKit's _setOverrideDeviceScaleFactor:, a private WKWebView method, so
// a WebKit without it is an error. It runs on the main thread.
func refDeviceScale(win *mygo.Window, scale float64) (backing, applied float64, err error) {
	mygo.RunOnMain(func() {
		if msgFloat == nil {
			lib, e := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_GLOBAL|purego.RTLD_NOW)
			if e != nil {
				err = e
				return
			}
			send, e := purego.Dlsym(lib, "objc_msgSend")
			if e != nil {
				err = e
				return
			}
			purego.RegisterFunc(&msgFloat, send)
			purego.RegisterFunc(&msgSetFloat, send)
		}
		nsWin := objc.ID(win.NativeHandle())
		backing = msgFloat(nsWin, objc.RegisterName("backingScaleFactor"))
		if scale <= 0 {
			return
		}
		web := findWebView(nsWin.Send(objc.RegisterName("contentView")))
		if web == 0 {
			err = errors.New("no WKWebView in the window")
			return
		}
		set := objc.RegisterName("_setOverrideDeviceScaleFactor:")
		if !objc.Send[bool](web, objc.RegisterName("respondsToSelector:"), set) {
			err = errors.New("WKWebView has no _setOverrideDeviceScaleFactor:")
			return
		}
		msgSetFloat(web, set, scale)
		applied = msgFloat(web, objc.RegisterName("_overrideDeviceScaleFactor"))
		if applied != scale {
			err = fmt.Errorf("WKWebView kept device scale override %g, not %g", applied, scale)
		}
	})
	return backing, applied, err
}

// findWebView returns the first WKWebView in the view tree under v.
func findWebView(v objc.ID) objc.ID {
	if v == 0 {
		return 0
	}
	if objc.Send[bool](v, objc.RegisterName("isKindOfClass:"), objc.GetClass("WKWebView")) {
		return v
	}
	subviews := v.Send(objc.RegisterName("subviews"))
	for i := range objc.Send[int](subviews, objc.RegisterName("count")) {
		if w := findWebView(subviews.Send(objc.RegisterName("objectAtIndex:"), i)); w != 0 {
			return w
		}
	}
	return 0
}
