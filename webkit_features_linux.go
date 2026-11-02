package main

import (
	"errors"
	"log"
	"strings"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
)

// WebKitGTK's feature API (2.42 and later). mygo loads the same library, 4.1
// before 4.0, so opening it here returns the handle mygo uses.
type webkitFeatureAPI struct {
	allFeatures  func() uintptr
	listLength   func(list uintptr) uint64
	listGet      func(list uintptr, i uint64) uintptr
	listUnref    func(list uintptr)
	identifier   func(feature uintptr) string
	status       func(feature uintptr) int32
	setEnabled   func(settings, feature uintptr, enabled bool)
	viewType     func() uintptr
	viewSettings func(view uintptr) uintptr
}

func loadWebKitFeatureAPI() (*webkitFeatureAPI, error) {
	var lib uintptr
	var err error
	for _, name := range []string{"libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"} {
		if lib, err = purego.Dlopen(name, purego.RTLD_NOW|purego.RTLD_GLOBAL); err == nil {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	api := &webkitFeatureAPI{}
	return api, bindSymbols(lib, map[string]any{
		"webkit_settings_get_all_features":    &api.allFeatures,
		"webkit_feature_list_get_length":      &api.listLength,
		"webkit_feature_list_get":             &api.listGet,
		"webkit_feature_list_unref":           &api.listUnref,
		"webkit_feature_get_identifier":       &api.identifier,
		"webkit_feature_get_status":           &api.status,
		"webkit_settings_set_feature_enabled": &api.setEnabled,
		"webkit_web_view_get_type":            &api.viewType,
		"webkit_web_view_get_settings":        &api.viewSettings,
	})
}

// bindSymbols registers every function from lib, or reports the first one
// missing without registering any.
func bindSymbols(lib uintptr, fns map[string]any) error {
	addrs := make(map[string]uintptr, len(fns))
	for sym := range fns {
		addr, err := purego.Dlsym(lib, sym)
		if err != nil || addr == 0 {
			return errors.New(sym + " is missing")
		}
		addrs[sym] = addr
	}
	for sym, fn := range fns {
		purego.RegisterFunc(fn, addrs[sym])
	}
	return nil
}

// each calls fn with every feature this WebKit knows.
func (api *webkitFeatureAPI) each(fn func(feature uintptr, id string, status int32)) {
	list := api.allFeatures()
	defer api.listUnref(list)
	for i, n := uint64(0), api.listLength(list); i < n; i++ {
		f := api.listGet(list, i)
		fn(f, api.identifier(f), api.status(f))
	}
}

// webkitFeaturesToEnable returns the early features this WebKit ships as
// stable, logging one line for any it leaves at the engine's default.
func webkitFeaturesToEnable() []string {
	api, err := loadWebKitFeatureAPI()
	if err != nil {
		log.Printf("WebKit features: keeping the engine's layout (%v)", err)
		return nil
	}
	var installed []webkitFeature
	api.each(func(_ uintptr, id string, status int32) { installed = append(installed, webkitFeature{id, status}) })
	enable, skipped := stableWebKitFeatures(installed, earlyWebKitFeatures)
	if len(skipped) > 0 {
		log.Printf("WebKit features: keeping the engine's layout (%s)", strings.Join(skipped, "; "))
	}
	return enable
}

// enableWebKitFeatures turns ids on in win's web view. Call it before the
// page loads: layout features are read when a page starts.
func enableWebKitFeatures(win *mygo.Window, ids []string) error {
	api, err := loadWebKitFeatureAPI()
	if err != nil {
		return err
	}
	gtk, err := loadGTKTree()
	if err != nil {
		return err
	}
	var result error
	mygo.RunOnMain(func() {
		view := gtk.find(win.NativeHandle(), api.viewType())
		if view == 0 {
			result = errors.New("no WebKitWebView in the window")
			return
		}
		settings, want, done := api.viewSettings(view), map[string]bool{}, 0
		for _, id := range ids {
			want[id] = true
		}
		api.each(func(f uintptr, id string, _ int32) {
			if want[id] {
				api.setEnabled(settings, f, true)
				done++
			}
		})
		if done != len(ids) {
			result = errors.New("a feature to enable is missing")
		}
	})
	return result
}

type gtkTree struct {
	children func(container uintptr) uintptr
	listFree func(list uintptr)
	isA      func(instance, typ uintptr) bool
	cType    func() uintptr
}

func loadGTKTree() (*gtkTree, error) {
	gtk, err := purego.Dlopen("libgtk-3.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, err
	}
	t := &gtkTree{}
	return t, bindSymbols(gtk, map[string]any{
		"gtk_container_get_children": &t.children,
		"g_list_free":                &t.listFree,
		"g_type_check_instance_is_a": &t.isA,
		"gtk_container_get_type":     &t.cType,
	})
}

// find returns the first widget under root (root included) of GType typ.
func (t *gtkTree) find(root, typ uintptr) uintptr {
	if root == 0 {
		return 0
	}
	if t.isA(root, typ) {
		return root
	}
	if !t.isA(root, t.cType()) {
		return 0
	}
	list := t.children(root)
	defer t.listFree(list)
	for l := list; l != 0; l = gListWord(l, 1) { // GList: data, next, prev
		if w := t.find(gListWord(l, 0), typ); w != 0 {
			return w
		}
	}
	return 0
}

func gListWord(p uintptr, i uintptr) uintptr {
	return *(*uintptr)(unsafe.Add(*(*unsafe.Pointer)(unsafe.Pointer(&p)), i*unsafe.Sizeof(p)))
}
