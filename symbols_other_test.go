//go:build !darwin

package main

import (
	"encoding/base64"
	"io/fs"
	"math"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// The SF Symbols the page draws and their Phosphor stand-ins on Windows
// and Linux, drawn at regular weight.
var pageSymbols = []struct{ symbol, file string }{
	{"chevron.left", "regular/caret-left.svg"},
	{"chevron.right", "regular/caret-right.svg"},
	{"chevron.down", "regular/caret-down.svg"},
	{"chevron.up", "regular/caret-up.svg"},
	{"sidebar.leading", "regular/sidebar.svg"},
	{"terminal", "regular/terminal-window.svg"},
	{"plus", "regular/plus.svg"},
	{"magnifyingglass", "regular/magnifying-glass.svg"},
	{"xmark.circle.fill", "fill/x-circle-fill.svg"},
	{"exclamationmark", "regular/exclamation-mark.svg"},
	{"questionmark", "regular/question-mark.svg"},
	{"xmark", "regular/x.svg"},
	{"wifi.slash", "regular/wifi-slash.svg"},
	{"star.fill", "fill/star-fill.svg"},
	{"archivebox.fill", "fill/archive-fill.svg"},
	{"square.grid.2x2.fill", "fill/squares-four-fill.svg"},
	{"bubble.left.and.bubble.right.fill", "fill/chats-fill.svg"},
	{"gearshape.fill", "fill/gear-fill.svg"},
}

// svgOf decodes an Image data URL and reads its root attributes.
func svgOf(t *testing.T, img SymbolImage) (src string, width, height float64, viewBox [4]float64) {
	t.Helper()
	b64, ok := strings.CutPrefix(img.DataURL, "data:image/svg+xml;base64,")
	if !ok {
		t.Fatalf("data URL %.40q is not a base64 SVG", img.DataURL)
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	src = string(data)
	attr := func(name string) string {
		_, v, ok := strings.Cut(src, " "+name+`="`)
		if !ok {
			t.Fatalf("no %s in %s", name, src)
		}
		v, _, _ = strings.Cut(v, `"`)
		return v
	}
	f := func(s string) float64 {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			t.Fatalf("%v in %s", err, src)
		}
		return v
	}
	width, height = f(attr("width")), f(attr("height"))
	for i, s := range strings.Fields(attr("viewBox")) {
		viewBox[i] = f(s)
	}
	return src, width, height, viewBox
}

func TestStandInsCoverThePage(t *testing.T) {
	if len(standIns) != len(pageSymbols) {
		t.Fatalf("%d stand-ins for %d symbols", len(standIns), len(pageSymbols))
	}
	if len(sfMetrics) != len(pageSymbols) {
		t.Fatalf("%d SF metrics for %d symbols", len(sfMetrics), len(pageSymbols))
	}
	regular, _ := parseSymbolWeight("regular")
	for i, want := range pageSymbols {
		s := standIns[i]
		if got := s.file(regular); s.symbol != want.symbol || got != "third_party/phosphor/"+want.file {
			t.Errorf("stand-in %d: %s drawn from %s, want %s from %s", i, s.symbol, got, want.symbol, want.file)
		}
		if m := sfMetrics[i].symbol; m != want.symbol {
			t.Errorf("SF metrics %d are for %s, want %s", i, m, want.symbol)
		}
	}
}

func TestStandInImages(t *testing.T) {
	near := func(a, b float64) bool { return math.Abs(a-b) < 1e-3 }
	for _, s := range standIns {
		for w, wname := range symbolWeights {
			const size = 21
			img, err := Symbols{}.Image(s.symbol, size, wname, 2)
			if err != nil {
				t.Fatalf("%s %s: %v", s.symbol, wname, err)
			}
			box := sfMetrics[slices.IndexFunc(sfMetrics[:], func(m sfMetric) bool { return m.symbol == s.symbol })].weights[w]
			// AppKit's box at 21 pt on a 2x display: the size rounded up to
			// whole pixels, the baseline to the nearest one.
			want := SymbolImage{
				Width:    math.Ceil(box.width*size*2-1e-3) / 2,
				Height:   math.Ceil(box.height*size*2-1e-3) / 2,
				Baseline: math.Round(box.baseline*size*2) / 2,
			}
			if !near(img.Width, want.Width) || !near(img.Height, want.Height) || !near(img.Baseline, want.Baseline) {
				t.Errorf("%s %s: %gx%g baseline %g, want macOS's %gx%g baseline %g",
					s.symbol, wname, img.Width, img.Height, img.Baseline, want.Width, want.Height, want.Baseline)
			}
			src, width, height, vb := svgOf(t, img)
			if !near(width, img.Width) || !near(height, img.Height) {
				t.Errorf("%s %s: SVG is %gx%g, image %gx%g", s.symbol, wname, width, height, img.Width, img.Height)
			}
			if strings.Count(src, "<path ") != 1 || !strings.Contains(src, `fill="#fff"`) {
				t.Errorf("%s %s: want one white path: %s", s.symbol, wname, src)
			}
			file := s.file(symbolWeight(w))
			raw, err := phosphor.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			d, err := svgPath(string(raw))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(src, `d="`+d+`"`) {
				t.Errorf("%s %s: not drawn from %s", s.symbol, wname, file)
			}
			// The icon's ink, in the image's points, fills SF's ink box
			// along one axis and is centred in it.
			ink, err := pathBounds(d)
			if err != nil {
				t.Fatal(err)
			}
			k := width / vb[2]
			if !near(k, height/vb[3]) {
				t.Errorf("%s %s: viewBox %v stretches the icon", s.symbol, wname, vb)
			}
			l, tp, r, b := (ink[0]-vb[0])*k, (ink[1]-vb[1])*k, (ink[2]-vb[0])*k, (ink[3]-vb[1])*k
			sl, st, sr, sb := box.left*size, box.top*size, box.right*size, box.bottom*size
			fillsX, fillsY := near(r-l, sr-sl), near(b-tp, sb-st)
			if !fillsX && !fillsY || r-l > sr-sl+1e-3 || b-tp > sb-st+1e-3 ||
				!near(l+r, sl+sr) || !near(tp+b, st+sb) {
				t.Errorf("%s %s: ink at %.2f,%.2f-%.2f,%.2f, SF's at %.2f,%.2f-%.2f,%.2f", s.symbol, wname, l, tp, r, b, sl, st, sr, sb)
			}
		}
	}
}

// An outline symbol is drawn from the Phosphor weight nearest its SF
// weight; a .fill symbol is always drawn from Phosphor's fill.
func TestStandInWeights(t *testing.T) {
	files := func(symbol string) (out []string) {
		s := standIns[slices.IndexFunc(standIns[:], func(s standIn) bool { return s.symbol == symbol })]
		for w := range symbolWeights {
			out = append(out, s.file(symbolWeight(w)))
		}
		return out
	}
	const p = "third_party/phosphor/"
	if got, want := files("chevron.right"), []string{
		p + "thin/caret-right-thin.svg", p + "thin/caret-right-thin.svg", p + "light/caret-right-light.svg",
		p + "regular/caret-right.svg", p + "regular/caret-right.svg", p + "bold/caret-right-bold.svg",
		p + "bold/caret-right-bold.svg", p + "bold/caret-right-bold.svg", p + "bold/caret-right-bold.svg",
	}; !slices.Equal(got, want) {
		t.Errorf("chevron.right is drawn from %v, want %v", got, want)
	}
	for _, f := range files("star.fill") {
		if f != p+"fill/star-fill.svg" {
			t.Errorf("star.fill is drawn from %s", f)
		}
	}
}

func TestUnknownSymbols(t *testing.T) {
	for _, name := range []string{"", "square.grid.2x2", "chevron.left.forwardslash.chevron.right", "Chevron.Right", "chevron.right ", "../LICENSE"} {
		if img, err := (Symbols{}).Image(name, 12, "regular", 2); err == nil {
			t.Errorf("Image(%q) = %+v, want an error", name, img)
		}
	}
	for _, c := range []struct {
		weight string
		size   float64
		scale  int
	}{{"Regular", 12, 2}, {"normal", 12, 2}, {"regular", 0, 2}, {"regular", -1, 2}, {"regular", math.NaN(), 2}, {"regular", 1e6, 2}, {"regular", 12, 0}, {"regular", 12, 4}} {
		if img, err := (Symbols{}).Image("plus", c.size, c.weight, c.scale); err == nil {
			t.Errorf("Image(plus, %v, %q, %d) = %+v, want an error", c.size, c.weight, c.scale, img)
		}
	}
}

func TestPhosphorFiles(t *testing.T) {
	want := map[string]bool{"third_party/phosphor/LICENSE": true}
	for _, s := range standIns {
		for w := range symbolWeights {
			want[s.file(symbolWeight(w))] = true
		}
	}
	err := fs.WalkDir(phosphor, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if !want[p] {
			t.Errorf("%s is embedded but never drawn", p)
		}
		delete(want, p)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for p := range want {
		t.Errorf("%s is drawn but not embedded", p)
	}
}

func TestPathBounds(t *testing.T) {
	for _, c := range []struct {
		d    string
		want [4]float64
	}{
		{"M10 20 L30 40 Z", [4]float64{10, 20, 30, 40}},
		{"M10,20l20,20h-30v-30z", [4]float64{0, 10, 30, 40}},
		{"M1-2.5e1L3.5.5", [4]float64{1, -25, 3.5, 0.5}},
		// A circle of radius 8 about (8, 8), with flags run together.
		{"M0 8a8 8 0 1116 0a8 8 0 11-16 0", [4]float64{0, 0, 16, 16}},
		// A cubic bulging past its end points: x peaks at 0.75·10.
		{"M0 0C10 0 10 10 0 10", [4]float64{0, 0, 7.5, 10}},
		{"M0 0Q10 5 0 10", [4]float64{0, 0, 5, 10}},
		// S reflects the previous control point: (10, 10) here, which
		// takes the second curve's y to 7.5, not 4.44.
		{"M0 0C0 -10 10 -10 10 0S20 10 20 0", [4]float64{0, -7.5, 20, 7.5}},
		// Phosphor's squares-four fill: four rounded squares in 40-216.
		{mustPhosphorPath(t, "third_party/phosphor/fill/squares-four-fill.svg"), [4]float64{40, 40, 216, 216}},
		{mustPhosphorPath(t, "third_party/phosphor/bold/plus-bold.svg"), [4]float64{28, 28, 228, 228}},
	} {
		got, err := pathBounds(c.d)
		if err != nil {
			t.Errorf("%.40s: %v", c.d, err)
			continue
		}
		for i := range got {
			if math.Abs(got[i]-c.want[i]) > 0.05 {
				t.Errorf("%.40s: bounds %v, want %v", c.d, got, c.want)
				break
			}
		}
	}
	for _, d := range []string{"", "10 20", "M10", "M10 20 X", "M0 0 a1 1 0 2 0 1 1"} {
		if b, err := pathBounds(d); err == nil {
			t.Errorf("pathBounds(%q) = %v, want an error", d, b)
		}
	}
}

func mustPhosphorPath(t *testing.T, file string) string {
	t.Helper()
	src, err := phosphor.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	d, err := svgPath(string(src))
	if err != nil {
		t.Fatal(err)
	}
	return d
}
