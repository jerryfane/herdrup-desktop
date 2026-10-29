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
	if w, h := float64(m.Rect.Dx()), float64(m.Rect.Dy()); w != 2*img.Width || h != 2*img.Height {
		t.Fatalf("PNG is %vx%v px for %vx%v pt at 2x", w, h, img.Width, img.Height)
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
	m1 := decodeSymbolPNG(t, one)
	if w, h := float64(m1.Rect.Dx()), float64(m1.Rect.Dy()); w != one.Width || h != one.Height {
		t.Fatalf("1x PNG is %vx%v px for %vx%v pt", w, h, one.Width, one.Height)
	}
	if math.Abs(one.Width-img.Width) > 1 || math.Abs(one.Height-img.Height) > 1 {
		t.Fatalf("%vx%v pt at 1x but %vx%v pt at 2x", one.Width, one.Height, img.Width, img.Height)
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

// inkBounds is the box of covered pixels, in points from the top-left.
func inkBounds(m *image.NRGBA, scale float64) (left, top, right, bottom float64) {
	b := image.Rectangle{}
	for y := range m.Rect.Dy() {
		for x := range m.Rect.Dx() {
			if m.Pix[y*m.Stride+4*x+3] != 0 {
				b = b.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	return float64(b.Min.X) / scale, float64(b.Min.Y) / scale, float64(b.Max.X) / scale, float64(b.Max.Y) / scale
}

// sfMetricsSize and sfMetricsScale are where TestSFMetrics measures: a
// thousand pixels per em, so a metric is good to 0.001 em.
const sfMetricsSize, sfMetricsScale = 500, 2

func boxOf(t *testing.T, symbol string, w symbolWeight) sfBox {
	t.Helper()
	img, err := Symbols{}.Image(symbol, sfMetricsSize, w.String(), sfMetricsScale)
	if err != nil {
		t.Fatal(err)
	}
	l, tp, r, b := inkBounds(decodeSymbolPNG(t, img), sfMetricsScale)
	const k = 1.0 / sfMetricsSize
	return sfBox{
		width: img.Width * k, height: img.Height * k, baseline: img.Baseline * k,
		left: l * k, top: tp * k, right: r * k, bottom: b * k,
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
			m.weights[w] = boxOf(t, s.symbol, symbolWeight(w))
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
				if math.Abs(fa[i]-fb[i]) > 0.0011 {
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
	b.WriteString("// sfMetrics measures every stand-in's SF Symbol with AppKit at 500 pt\n")
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

// probe is one image Symbols.Image drew, for comparing with SwiftUI
// (.github/symbols/swiftui.swift).
type probe struct {
	Symbol    string     `json:"symbol"`
	PointSize float64    `json:"pointSize"`
	Weight    string     `json:"weight"`
	Scale     int        `json:"scale"`
	Width     float64    `json:"width"`
	Height    float64    `json:"height"`
	Baseline  float64    `json:"baseline"`
	Ink       [4]float64 `json:"ink"`
	File      string     `json:"file"`
}

// probeCases are the glyphs herdrup's agent list draws, in the sizes it
// draws them, then every stand-in at 21 pt medium.
func probeCases() []probe {
	cs := []probe{
		{Symbol: "chevron.right", PointSize: 12, Weight: "semibold"},
		{Symbol: "square.grid.2x2.fill", PointSize: 21, Weight: "medium"},
		{Symbol: "exclamationmark", PointSize: 10, Weight: "heavy"},
		{Symbol: "questionmark", PointSize: 10, Weight: "heavy"},
		{Symbol: "wifi.slash", PointSize: 10, Weight: "heavy"},
		{Symbol: "xmark", PointSize: 10, Weight: "heavy"},
		{Symbol: "bubble.left.and.bubble.right.fill", PointSize: 21, Weight: "medium"},
		{Symbol: "gearshape.fill", PointSize: 21, Weight: "medium"},
		{Symbol: "chevron.right", PointSize: 13, Weight: "semibold"},
		{Symbol: "magnifyingglass", PointSize: 15, Weight: "medium"},
	}
	for _, s := range standIns {
		cs = append(cs, probe{Symbol: s.symbol, PointSize: 21, Weight: "medium"})
	}
	return cs
}

// TestSymbolDump writes, with HERDRUP_SYMBOLS_OUT set, the PNGs Image
// draws for probeCases at 1x, 2x and 3x, and go.json listing them.
func TestSymbolDump(t *testing.T) {
	dir := os.Getenv("HERDRUP_SYMBOLS_OUT")
	if dir == "" {
		t.Skip("HERDRUP_SYMBOLS_OUT is not set")
	}
	if err := os.MkdirAll(filepath.Join(dir, "go"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Logf("macOS %s", osVersion())
	var out []probe
	for _, c := range probeCases() {
		for scale := 1; scale <= 3; scale++ {
			img, err := Symbols{}.Image(c.Symbol, c.PointSize, c.Weight, scale)
			if err != nil {
				t.Fatal(err)
			}
			m := decodeSymbolPNG(t, img)
			p := c
			p.Scale, p.Width, p.Height, p.Baseline = scale, img.Width, img.Height, img.Baseline
			l, tp, r, b := inkBounds(m, float64(scale))
			p.Ink = [4]float64{l, tp, r, b}
			p.File = fmt.Sprintf("%s-%g-%s@%dx.png", c.Symbol, c.PointSize, c.Weight, scale)
			var buf bytes.Buffer
			if err := png.Encode(&buf, m); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "go", p.File), buf.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s %gpt %s @%dx: %gx%g pt, baseline %g, ink %v", p.Symbol, p.PointSize, p.Weight, scale, p.Width, p.Height, p.Baseline, p.Ink)
			out = append(out, p)
		}
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "go.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}
