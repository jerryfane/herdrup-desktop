package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// solid returns a w×h picture of c.
func solid(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

var grey = color.RGBA{100, 100, 100, 255}

func TestSameScaleCountsPixelsOverTolerance(t *testing.T) {
	ref := solid(4, 4, grey)
	got := solid(4, 4, grey)
	got.SetRGBA(0, 0, color.RGBA{103, 100, 100, 255}) // delta 3: over tol 2
	got.SetRGBA(1, 0, color.RGBA{100, 98, 100, 255})  // delta 2: within
	got.SetRGBA(3, 3, color.RGBA{100, 100, 0, 255})   // delta 100
	r, diff, err := Compare(ref, got, Options{RefScale: 1, Tol: 2})
	if err != nil {
		t.Fatal(err)
	}
	if r.Compared != 16 || r.Over != 2 || r.MaxDelta != 100 || r.SizeMismatch {
		t.Fatalf("got %+v", r)
	}
	if r.OverPct != 12.5 {
		t.Fatalf("OverPct %v, want 12.5", r.OverPct)
	}
	if want := float64(3+2+100) / 16; r.MeanDelta != want {
		t.Fatalf("MeanDelta %v, want %v", r.MeanDelta, want)
	}
	// Over the tolerance is red; within it is not.
	if c := diff.RGBAAt(3, 3); c.R < 128 || c.G >= c.R/2 || c.B >= c.R/2 {
		t.Fatalf("diff at a large delta is %v, want red", c)
	}
	if c := diff.RGBAAt(1, 0); c.G < c.R/2 {
		t.Fatalf("diff within tolerance is %v, want not red", c)
	}
}

func TestCropTopAndMaskInReferencePoints(t *testing.T) {
	// A 2x reference, 3×3 pt: a 1 pt status bar on top, then 3×2 pt.
	ref := solid(6, 6, grey)
	for x := range 6 {
		ref.SetRGBA(x, 0, color.RGBA{255, 255, 255, 255})
		ref.SetRGBA(x, 1, color.RGBA{255, 255, 255, 255})
	}
	got := solid(6, 4, grey)
	// A difference inside the masked point (x 2 pt, y 2 pt in reference
	// points, the capture's second row of points)...
	got.SetRGBA(4, 2, color.RGBA{0, 0, 0, 255})
	got.SetRGBA(5, 3, color.RGBA{0, 0, 0, 255})
	// ...and one outside it.
	got.SetRGBA(0, 0, color.RGBA{0, 0, 0, 255})
	mask := []Rect{{Name: "m", X: 2, Y: 2, W: 1, H: 1}}
	r, diff, err := Compare(ref, got, Options{RefScale: 2, CropTopPt: 1, Tol: 0, Mask: mask})
	if err != nil {
		t.Fatal(err)
	}
	if r.SizeMismatch || r.Masked != 4 || r.Compared != 20 || r.Over != 1 {
		t.Fatalf("got %+v", r)
	}
	if b := diff.Bounds(); b.Dx() != 6 || b.Dy() != 4 {
		t.Fatalf("diff is %v, want 6×4", b)
	}
	if c := diff.RGBAAt(4, 2); c.B <= c.R {
		t.Fatalf("masked pixel drawn %v, want blue", c)
	}
}

func TestStateScopedMaskOnlyHidesItsStates(t *testing.T) {
	// 1x, 2×1 pt: the left point differs (under the "always" rect), the
	// right point differs (under a rect scoped to loading).
	ref := solid(2, 1, grey)
	got := solid(2, 1, color.RGBA{0, 0, 0, 255})
	mask := Mask{Rects: []Rect{
		{Name: "always", X: 0, Y: 0, W: 1, H: 1},
		{Name: "field", X: 1, Y: 0, W: 1, H: 1, States: []string{"empty", "loading"}},
	}}
	for _, tc := range []struct {
		state        string
		masked, over int
	}{
		{"loading", 2, 0},   // both rects apply
		{"empty", 2, 0},     // any listed state applies
		{"populated", 1, 1}, // the scoped rect must not hide this state's difference
		{"", 1, 1},          // no state: only unscoped rects
	} {
		r, _, err := Compare(ref, got, Options{RefScale: 1, Tol: 0, Mask: mask.RectsFor(tc.state)})
		if err != nil {
			t.Fatal(err)
		}
		if r.Masked != tc.masked || r.Over != tc.over {
			t.Errorf("state %q: masked %d over %d, want %d and %d", tc.state, r.Masked, r.Over, tc.masked, tc.over)
		}
	}
}

func TestOneXCaptureComparesAgainstBoxFilteredReference(t *testing.T) {
	// 2x reference, 2×1 pt. The first point's four pixels average to
	// (10+20+30+42)/4 = 25.5 → 26 (rounded, not truncated); the second's
	// to 200.
	ref := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for i, v := range []uint8{10, 20, 200, 200, 30, 42, 200, 200} {
		ref.SetRGBA(i%4, i/4, color.RGBA{v, v, v, 255})
	}
	got := image.NewRGBA(image.Rect(0, 0, 2, 1))
	got.SetRGBA(0, 0, color.RGBA{26, 26, 26, 255})
	got.SetRGBA(1, 0, color.RGBA{197, 200, 200, 255})
	r, diff, err := Compare(ref, got, Options{RefScale: 2, Tol: 0})
	if err != nil {
		t.Fatal(err)
	}
	if r.GotScale != 1 || r.Scale != 1 || r.SizeMismatch {
		t.Fatalf("got %+v", r)
	}
	if r.Over != 1 || r.MaxDelta != 3 {
		t.Fatalf("got %+v, want one pixel over with delta 3", r)
	}
	if b := diff.Bounds(); b.Dx() != 2 || b.Dy() != 1 {
		t.Fatalf("diff is %v, want 2×1", b)
	}
}

func TestSizeMismatchCountsMissingPixels(t *testing.T) {
	ref := solid(3, 3, grey)
	got := solid(3, 2, grey) // a row short
	r, diff, err := Compare(ref, got, Options{RefScale: 1, Tol: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !r.SizeMismatch || r.WantPx != [2]int{3, 3} || r.Over != 3 || r.MaxDelta != 255 {
		t.Fatalf("got %+v", r)
	}
	if c := diff.RGBAAt(1, 2); c != (color.RGBA{255, 0, 255, 255}) {
		t.Fatalf("missing pixel drawn %v, want magenta", c)
	}
	// A capture one pixel too wide is still compared, with its extra
	// column counted as differing.
	r, _, err = Compare(ref, solid(4, 3, grey), Options{RefScale: 1, Tol: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !r.SizeMismatch || r.Over != 3 || r.Compared != 12 {
		t.Fatalf("wider capture: got %+v", r)
	}
	// One pixel too narrow: the missing column differs.
	r, _, err = Compare(solid(4, 3, grey), solid(3, 3, grey), Options{RefScale: 1, Tol: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !r.SizeMismatch || r.Over != 3 || r.Compared != 12 {
		t.Fatalf("narrower capture: got %+v", r)
	}
	// A 2x capture a pixel short of 4 pt is still read as 2x.
	r, _, err = Compare(solid(8, 4, grey), solid(7, 4, grey), Options{RefScale: 2, Tol: 10})
	if err != nil {
		t.Fatal(err)
	}
	if r.GotScale != 2 || r.WantPx != [2]int{8, 4} || r.Over != 4 {
		t.Fatalf("2x capture a pixel narrow: got %+v", r)
	}
}

func TestPNGColorChunks(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, solid(1, 1, grey)); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()
	if got := pngColor(data); got != "none" {
		t.Fatalf("Go's PNG: %q, want none", got)
	}
	// Insert an sRGB chunk after IHDR (8 + 25 bytes).
	srgb := []byte{0, 0, 0, 1, 's', 'R', 'G', 'B', 0, 0xd9, 0xc9, 0x2c, 0x7f}
	tagged := append(append(append([]byte{}, data[:33]...), srgb...), data[33:]...)
	if got := pngColor(tagged); got != "[sRGB]" {
		t.Fatalf("tagged: %q, want [sRGB]", got)
	}
}
