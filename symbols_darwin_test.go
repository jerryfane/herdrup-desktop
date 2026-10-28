//go:build darwin

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/format"
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

func decodeSymbolPNG(t *testing.T, img SymbolImage) *image.NRGBA {
	t.Helper()
	b64, ok := strings.CutPrefix(img.DataURL, "data:image/png;base64,")
	if !ok {
		t.Fatalf("data URL %.40q is not a base64 PNG", img.DataURL)
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	m, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	n, ok := m.(*image.NRGBA)
	if !ok {
		t.Fatalf("PNG decodes to %T, want *image.NRGBA", m)
	}
	return n
}

// inkOf sums the coverage and checks that every covered pixel is white.
func inkOf(t *testing.T, m *image.NRGBA) (sum int) {
	t.Helper()
	for i := 0; i < len(m.Pix); i += 4 {
		if a := m.Pix[i+3]; a != 0 {
			if m.Pix[i] != 0xff || m.Pix[i+1] != 0xff || m.Pix[i+2] != 0xff {
				t.Fatalf("pixel %d is %v, want white", i/4, m.Pix[i:i+4])
			}
			sum += int(a)
		}
	}
	return sum
}

func TestSymbolImageDarwin(t *testing.T) {
	img, err := Symbols{}.Image("chevron.right", 12, "semibold", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !(img.Width > 2 && img.Width < 24 && img.Height > 6 && img.Height < 24) {
		t.Fatalf("chevron.right at 12 pt is %v by %v pt", img.Width, img.Height)
	}
	if !(img.Baseline >= 0 && img.Baseline < img.Height/2) {
		t.Fatalf("baseline %v is not in the lower half of %v pt", img.Baseline, img.Height)
	}
	m := decodeSymbolPNG(t, img)
	if w, h := m.Rect.Dx(), m.Rect.Dy(); w != ceilPixels(img.Width, 2) || h != ceilPixels(img.Height, 2) {
		t.Fatalf("PNG is %dx%d px, want %vx%v pt at 2x", w, h, img.Width, img.Height)
	}
	semibold := inkOf(t, m)
	if semibold == 0 {
		t.Fatal("chevron.right has no ink")
	}

	again, err := Symbols{}.Image("chevron.right", 12, "semibold", 2)
	if err != nil || again != img {
		t.Fatalf("second call: %v, %v; want the cached image", again, err)
	}

	one, err := Symbols{}.Image("chevron.right", 12, "semibold", 1)
	if err != nil {
		t.Fatal(err)
	}
	if one.Width != img.Width || one.Height != img.Height || one.Baseline != img.Baseline {
		t.Fatalf("at 1x: %v by %v, baseline %v; at 2x: %v by %v, baseline %v",
			one.Width, one.Height, one.Baseline, img.Width, img.Height, img.Baseline)
	}
	m1 := decodeSymbolPNG(t, one)
	if m1.Rect.Dx() != ceilPixels(img.Width, 1) {
		t.Fatalf("1x PNG is %d px wide for %v pt", m1.Rect.Dx(), img.Width)
	}
	// Four times the pixels at 2x: drawn at scale, not 1x in a corner.
	if r := float64(semibold) / float64(inkOf(t, m1)); r < 3.4 || r > 4.6 {
		t.Fatalf("2x has %.2f times the ink of 1x, want 4", r)
	}

	light, err := Symbols{}.Image("chevron.right", 12, "ultraLight", 2)
	if err != nil {
		t.Fatal(err)
	}
	if ink := inkOf(t, decodeSymbolPNG(t, light)); ink >= semibold {
		t.Fatalf("ultraLight ink %d is not below semibold's %d", ink, semibold)
	}

	if _, err := (Symbols{}).Image("no.such.symbol.herdrup", 12, "regular", 2); err == nil {
		t.Fatal("an unknown symbol drew")
	}
}

// measured is one symbol measured at 100 pt and 2x.
type measured struct {
	metrics symbolMetrics
	align   nsRect
	ink     *image.Alpha
}

func measure(t *testing.T, name string, size float64, w symbolWeight) measured {
	t.Helper()
	if err := loadAppKit(); err != nil {
		t.Fatal(err)
	}
	var (
		r   measured
		err error
	)
	withPool(func() {
		var img objc.ID
		if img, err = sfSymbol(name, size, w); err != nil {
			return
		}
		r.metrics = measureSymbol(img)
		r.align = appKit.rect(img, sel("alignmentRect"))
		r.ink, err = rasterSymbol(img, r.metrics.size, 2)
	})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// inkBounds is the box of covered pixels, in points from the top-left.
func inkBounds(a *image.Alpha, scale float64) (left, top, right, bottom float64) {
	b := image.Rectangle{}
	for y := range a.Rect.Dy() {
		for x := range a.Rect.Dx() {
			if a.Pix[y*a.Stride+x] != 0 {
				b = b.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	return float64(b.Min.X) / scale, float64(b.Min.Y) / scale, float64(b.Max.X) / scale, float64(b.Max.Y) / scale
}

const sfMetricsSize = 100

func boxOf(r measured) sfBox {
	l, t, rt, b := inkBounds(r.ink, 2)
	k := 1.0 / sfMetricsSize
	return sfBox{
		width: r.metrics.size.Width * k, height: r.metrics.size.Height * k, baseline: r.metrics.baseline * k,
		left: l * k, top: t * k, right: rt * k, bottom: b * k,
	}
}

// TestSFMetrics checks symbols_sfmetrics.go against AppKit. With
// HERDRUP_SYMBOLS_OUT set it also writes a fresh symbols_sfmetrics.go
// there, to copy over the stale one.
func TestSFMetrics(t *testing.T) {
	var fresh []sfMetric
	for _, s := range standIns {
		m := sfMetric{symbol: s.symbol}
		for w := range symbolWeights {
			m.weights[w] = boxOf(measure(t, s.symbol, sfMetricsSize, symbolWeight(w)))
		}
		fresh = append(fresh, m)
	}
	if dir := os.Getenv("HERDRUP_SYMBOLS_OUT"); dir != "" {
		writeSFMetrics(t, filepath.Join(dir, "symbols_sfmetrics.go"), fresh)
	}
	have := map[string]sfMetric{}
	for _, m := range sfMetrics {
		have[m.symbol] = m
	}
	for _, m := range fresh {
		old, ok := have[m.symbol]
		if !ok {
			t.Errorf("symbols_sfmetrics.go has no %s", m.symbol)
			continue
		}
		for w := range m.weights {
			a, b := m.weights[w], old.weights[w]
			fa := []float64{a.width, a.height, a.baseline, a.left, a.top, a.right, a.bottom}
			fb := []float64{b.width, b.height, b.baseline, b.left, b.top, b.right, b.bottom}
			for i := range fa {
				if math.Abs(fa[i]-fb[i]) > 0.002 {
					t.Errorf("%s %s: AppKit gives %+v, symbols_sfmetrics.go %+v; regenerate it", m.symbol, symbolWeight(w), a, b)
					break
				}
			}
		}
	}
}

func osVersion() string {
	var v string
	withPool(func() {
		s := msg(msg(class("NSProcessInfo"), "processInfo"), "operatingSystemVersionString")
		v = goString(s)
	})
	return v
}

func goString(s objc.ID) string {
	if s == 0 {
		return ""
	}
	p := msg(s, "UTF8String")
	n := int(msg(s, "lengthOfBytesUsingEncoding:", 4))
	if p == 0 || n == 0 {
		return ""
	}
	return string(unsafe.Slice(*(**byte)(unsafe.Pointer(&p)), n))
}

func writeSFMetrics(t *testing.T, path string, ms []sfMetric) {
	t.Helper()
	var b bytes.Buffer
	f := func(v float64) string { return fmt.Sprintf("%.4f", v) }
	fmt.Fprintf(&b, "// Code generated by TestSFMetrics on macOS (%s, %s); DO NOT EDIT.\n\n", osVersion(), runtime.GOARCH)
	b.WriteString("package main\n\n")
	b.WriteString("// sfMetrics measures every stand-in's SF Symbol with AppKit at 100 pt\n")
	b.WriteString("// and 2x. Regenerate on a Mac:\n")
	b.WriteString("//\n//\tHERDRUP_SYMBOLS_OUT=$TMPDIR go test -run TestSFMetrics .\n")
	b.WriteString("//\tcp $TMPDIR/symbols_sfmetrics.go .\n")
	b.WriteString("var sfMetrics = [...]sfMetric{\n")
	for _, m := range ms {
		fmt.Fprintf(&b, "{%q, [len(symbolWeights)]sfBox{\n", m.symbol)
		for w, x := range m.weights {
			fmt.Fprintf(&b, "{%s, %s, %s, %s, %s, %s, %s}, // %s\n",
				f(x.width), f(x.height), f(x.baseline), f(x.left), f(x.top), f(x.right), f(x.bottom), symbolWeight(w))
		}
		b.WriteString("}},\n")
	}
	b.WriteString("}\n")
	src, err := format.Source(b.Bytes())
	if err != nil {
		t.Fatalf("%v\n%s", err, b.Bytes())
	}
	if err := os.WriteFile(path, src, 0o644); err != nil {
		t.Fatal(err)
	}
}

// probe is what AppKit says about one symbol image, for comparing with
// SwiftUI (.github/symbols/swiftui.swift).
type probe struct {
	Symbol    string     `json:"symbol"`
	PointSize float64    `json:"pointSize"`
	Weight    string     `json:"weight"`
	Width     float64    `json:"width"`
	Height    float64    `json:"height"`
	Baseline  float64    `json:"baseline"`
	Align     [4]float64 `json:"alignmentRect"`
	Ink       [4]float64 `json:"ink"`
	Pixels    [2]int     `json:"pixels2x"`
	// Linear is Width, Height and Baseline predicted from 100 pt.
	Linear    [3]float64      `json:"linearFrom100"`
	Class     string          `json:"class"`
	Reps      []string        `json:"reps"`
	Responds  map[string]bool `json:"responds"`
	Baselines map[string]float64
}

type probeCase struct {
	symbol string
	size   float64
	weight string
}

// probeCases are the glyphs herdrup's agent list draws, in the sizes it
// draws them, then every stand-in at 21 pt medium.
func probeCases() []probeCase {
	cs := []probeCase{
		{"chevron.right", 12, "semibold"},
		{"square.grid.2x2.fill", 21, "medium"},
		{"exclamationmark", 10, "heavy"},
		{"questionmark", 10, "heavy"},
		{"wifi.slash", 10, "heavy"},
		{"bubble.left.and.bubble.right.fill", 21, "medium"},
		{"gearshape.fill", 21, "medium"},
	}
	for _, s := range standIns {
		cs = append(cs, probeCase{s.symbol, 21, "medium"})
	}
	return cs
}

// logSelectors logs the instance methods of each class, and of its
// superclasses short of NSObject, that mention baselines, alignment or
// insets: which of them AppKit has differs between macOS versions.
func logSelectors(t *testing.T, classes ...string) {
	lib, err := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	if err != nil {
		t.Fatal(err)
	}
	var (
		copyMethods func(cls objc.Class, n *uint32) *uintptr
		methodName  func(m uintptr) objc.SEL
		selName     func(s objc.SEL) string
		free        func(p *uintptr)
		className   func(c objc.Class) string
	)
	purego.RegisterLibFunc(&copyMethods, lib, "class_copyMethodList")
	purego.RegisterLibFunc(&methodName, lib, "method_getName")
	purego.RegisterLibFunc(&selName, lib, "sel_getName")
	purego.RegisterLibFunc(&free, purego.RTLD_DEFAULT, "free")
	purego.RegisterLibFunc(&className, lib, "class_getName")
	for _, name := range classes {
		for c := objc.GetClass(name); c != 0 && c != objc.GetClass("NSObject"); c = c.SuperClass() {
			var n uint32
			list := copyMethods(c, &n)
			if list == nil {
				continue
			}
			var found []string
			for _, m := range unsafe.Slice(list, n) {
				s := selName(methodName(m))
				if l := strings.ToLower(s); strings.Contains(l, "baseline") || strings.Contains(l, "alignment") || strings.Contains(l, "inset") {
					found = append(found, s)
				}
			}
			free(list)
			t.Logf("%s (%d methods): %s", className(c), n, strings.Join(found, " "))
		}
	}
}

// TestSymbolDump writes, with HERDRUP_SYMBOLS_OUT set, the PNGs Image
// draws for probeCases at 2x and what AppKit says about each.
func TestSymbolDump(t *testing.T) {
	dir := os.Getenv("HERDRUP_SYMBOLS_OUT")
	if dir == "" {
		t.Skip("HERDRUP_SYMBOLS_OUT is not set")
	}
	if err := os.MkdirAll(filepath.Join(dir, "go"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Logf("macOS %s", osVersion())
	logSelectors(t, "NSImage", "NSSymbolImageRep", "NSImageSymbolConfiguration")
	selectors := []string{"baselineOffsetFromBottom", "_baselineOffsetFromBottom", "hasBaseline", "alignmentRect", "symbolConfiguration"}
	var out []probe
	for _, c := range probeCases() {
		w, _ := parseSymbolWeight(c.weight)
		img, err := Symbols{}.Image(c.symbol, c.size, c.weight, 2)
		if err != nil {
			t.Fatal(err)
		}
		m := decodeSymbolPNG(t, img)
		file := fmt.Sprintf("%s-%g-%s@2x.png", c.symbol, c.size, c.weight)
		var buf bytes.Buffer
		if err := png.Encode(&buf, m); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "go", file), buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		r := measure(t, c.symbol, c.size, w)
		l, tp, rt, b := inkBounds(r.ink, 2)
		big := boxOf(measure(t, c.symbol, sfMetricsSize, w))
		p := probe{
			Symbol: c.symbol, PointSize: c.size, Weight: c.weight,
			Width: img.Width, Height: img.Height, Baseline: img.Baseline,
			Align:     [4]float64{r.align.Origin.X, r.align.Origin.Y, r.align.Size.Width, r.align.Size.Height},
			Ink:       [4]float64{l, tp, rt, b},
			Pixels:    [2]int{m.Rect.Dx(), m.Rect.Dy()},
			Linear:    [3]float64{big.width * c.size, big.height * c.size, big.baseline * c.size},
			Responds:  map[string]bool{},
			Baselines: map[string]float64{},
		}
		withPool(func() {
			im, err := sfSymbol(c.symbol, c.size, w)
			if err != nil {
				t.Error(err)
				return
			}
			p.Class = goString(msg(im, "className"))
			reps := msg(im, "representations")
			for i := range int(msg(reps, "count")) {
				rep := msg(reps, "objectAtIndex:", uintptr(i))
				sz := appKit.size(rep, sel("size"))
				p.Reps = append(p.Reps, fmt.Sprintf("%s %gx%g", goString(msg(rep, "className")), sz.Width, sz.Height))
				for _, s := range selectors {
					if msg(rep, "respondsToSelector:", uintptr(sel(s)))&0xff != 0 {
						p.Responds["rep."+s] = true
					}
				}
			}
			for _, s := range selectors {
				ok := msg(im, "respondsToSelector:", uintptr(sel(s)))&0xff != 0
				p.Responds[s] = ok
				if ok && strings.Contains(s, "baselineOffset") {
					p.Baselines[s] = appKit.float(im, sel(s))
				}
			}
		})
		t.Logf("%s %gpt %s: %gx%g pt (%dx%d px), baseline %g, alignmentRect %v, ink %v, linear from 100 pt %v",
			c.symbol, c.size, c.weight, p.Width, p.Height, p.Pixels[0], p.Pixels[1], p.Baseline, p.Align, p.Ink, p.Linear)
		out = append(out, p)
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}
