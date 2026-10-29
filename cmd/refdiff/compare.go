package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"math"
)

// Rect is a masked area in reference points: origin at the top-left of
// the whole reference picture, status bar included. States, when set,
// limits it to the references of those states (see Mask.RectsFor).
type Rect struct {
	Name   string   `json:"name"`
	X      float64  `json:"x"`
	Y      float64  `json:"y"`
	W      float64  `json:"w"`
	H      float64  `json:"h"`
	States []string `json:"states,omitempty"`
	Why    string   `json:"why,omitempty"`
}

// Mask is a mask file: the areas that are not compared.
type Mask struct {
	Device string `json:"device"`
	Note   string `json:"note,omitempty"`
	Rects  []Rect `json:"rects"`
}

// RectsFor returns the rects that apply to a reference of `state`: every
// rect without States, plus those listing it. An empty state gets only the
// rects without States.
func (m Mask) RectsFor(state string) []Rect {
	var out []Rect
	for _, r := range m.Rects {
		if len(r.States) == 0 {
			out = append(out, r)
			continue
		}
		for _, s := range r.States {
			if state != "" && s == state {
				out = append(out, r)
				break
			}
		}
	}
	return out
}

// Options says how to line the two pictures up and what counts as a
// differing pixel.
type Options struct {
	// RefScale is the reference's pixels per point.
	RefScale int
	// CropTopPt is cut from the top of the reference (its status bar);
	// the capture starts below it.
	CropTopPt float64
	// Tol is the largest channel difference that still counts as equal.
	Tol  int
	Mask []Rect
	// ShiftTilePt, when above 0, also looks for displaced content: the
	// compared area is cut into tiles this many points square, and a tile
	// is reported in Result.Shifted when the capture matches it clearly
	// better moved by up to ShiftMaxPx compared pixels (see shifted).
	ShiftTilePt float64
	ShiftMaxPx  int
}

// Shift is a tile whose content sits elsewhere in the capture: moved by
// (Dx, Dy) compared pixels (positive: right, down) the capture matches the
// reference's tile with a mean luma difference of Best instead of Mean.
// XPt and YPt are the tile's top-left in reference points, status bar
// included, like mask rects.
type Shift struct {
	XPt  float64 `json:"xPt"`
	YPt  float64 `json:"yPt"`
	Dx   int     `json:"dx"`
	Dy   int     `json:"dy"`
	Mean float64 `json:"mean"`
	Best float64 `json:"best"`
}

// Result describes a comparison. Pixels are counted at Scale, the lower
// of the two pictures' scales.
type Result struct {
	RefPx [2]int `json:"refPx"`
	GotPx [2]int `json:"gotPx"`
	// WantPx is the size the capture should have: the reference below
	// the crop, at the capture's scale.
	WantPx   [2]int `json:"wantPx"`
	GotScale int    `json:"gotScale"`
	Scale    int    `json:"scale"`
	// SizeMismatch: the capture is not WantPx. The pixels only one picture
	// has are compared as differing by 255.
	SizeMismatch bool    `json:"sizeMismatch"`
	Compared     int     `json:"compared"`
	Masked       int     `json:"masked"`
	Over         int     `json:"over"`
	OverPct      float64 `json:"overPct"`
	MaxDelta     int     `json:"maxDelta"`
	MeanDelta    float64 `json:"meanDelta"`
	// Shifted lists displaced tiles (Options.ShiftTilePt); empty when the
	// scan is off or nothing moved.
	Shifted []Shift `json:"shifted,omitempty"`
}

// Compare lines got up with the reference below its status bar, top-left
// to top-left, and compares them pixel by pixel outside the mask. The
// capture's scale is its width over the reference's width in points,
// rounded. When the capture has a lower scale than the reference, the
// reference is box-filtered down to it (each output pixel is the rounded
// mean of a k×k block of 8-bit sRGB values); a higher-scale capture is
// filtered down the same way. Pixels are composited over black (alpha is
// not compared). It returns the result and a diff picture at the
// compared scale.
func Compare(ref, got image.Image, o Options) (Result, *image.RGBA, error) {
	var r Result
	rb, gb := ref.Bounds(), got.Bounds()
	r.RefPx = [2]int{rb.Dx(), rb.Dy()}
	r.GotPx = [2]int{gb.Dx(), gb.Dy()}
	if o.RefScale < 1 || rb.Dx()%o.RefScale != 0 || rb.Dy()%o.RefScale != 0 {
		return r, nil, fmt.Errorf("reference %dx%d px is not a whole number of points at scale %d", rb.Dx(), rb.Dy(), o.RefScale)
	}
	cropF := o.CropTopPt * float64(o.RefScale)
	crop := int(math.Round(cropF))
	if math.Abs(cropF-float64(crop)) > 1e-9 || crop < 0 || crop >= rb.Dy() {
		return r, nil, fmt.Errorf("crop of %g pt is not a whole number of reference pixels inside the picture", o.CropTopPt)
	}
	widthPt := rb.Dx() / o.RefScale
	r.GotScale = max(1, int(math.Round(float64(gb.Dx())/float64(widthPt))))
	r.Scale = min(o.RefScale, r.GotScale)
	if o.RefScale%r.Scale != 0 || r.GotScale%r.Scale != 0 {
		return r, nil, fmt.Errorf("scales %d (reference) and %d (capture) have no whole common factor", o.RefScale, r.GotScale)
	}
	r.WantPx = [2]int{widthPt * r.GotScale, (rb.Dy() - crop) * r.GotScale / o.RefScale}
	r.SizeMismatch = r.GotPx != r.WantPx
	rp := downscale(toRGBA(ref, image.Rect(rb.Min.X, rb.Min.Y+crop, rb.Max.X, rb.Max.Y)), o.RefScale/r.Scale)
	gp := downscale(toRGBA(got, gb), r.GotScale/r.Scale)

	w := max(rp.Rect.Dx(), gp.Rect.Dx())
	h := max(rp.Rect.Dy(), gp.Rect.Dy())
	masked := maskBits(o.Mask, w, h, float64(r.Scale), o.CropTopPt)
	diff := image.NewRGBA(image.Rect(0, 0, w, h))
	var sum int64
	for y := range h {
		for x := range w {
			i := y*w + x
			d := diff.Pix[y*diff.Stride+x*4 : y*diff.Stride+x*4+4]
			inRef := x < rp.Rect.Dx() && y < rp.Rect.Dy()
			inGot := x < gp.Rect.Dx() && y < gp.Rect.Dy()
			var a, b []uint8
			if inRef {
				a = rp.Pix[y*rp.Stride+x*4 : y*rp.Stride+x*4+3]
			}
			if inGot {
				b = gp.Pix[y*gp.Stride+x*4 : y*gp.Stride+x*4+3]
			}
			if masked[i] {
				r.Masked++
				// Masked: dimmed blue.
				l := luma(a, b) / 4
				d[0], d[1], d[2], d[3] = l, l, 96+l/2, 255
				continue
			}
			r.Compared++
			delta := 255
			if inRef && inGot {
				delta = max(absDiff(a[0], b[0]), absDiff(a[1], b[1]), absDiff(a[2], b[2]))
			}
			sum += int64(delta)
			r.MaxDelta = max(r.MaxDelta, delta)
			switch {
			case !inRef || !inGot:
				// Only one picture has this pixel (the sizes differ): it
				// differs, whatever the tolerance. Magenta.
				r.Over++
				d[0], d[1], d[2], d[3] = 255, 0, 255, 255
			case delta > o.Tol:
				r.Over++
				// Over the tolerance: red, brighter for larger deltas,
				// over the reference's brightness so its shapes show.
				l := luma(a, nil) / 3
				d[0], d[1], d[2], d[3] = uint8(128+delta*127/255), l, l, 255
			case delta > 0:
				// Within the tolerance but not equal: dim amber.
				l := luma(a, b) / 4
				d[0], d[1], d[2], d[3] = 96+l, 64+l, l, 255
			default:
				// Equal: the picture, dimmed to grey.
				l := luma(a, b) / 4
				d[0], d[1], d[2], d[3] = l, l, l, 255
			}
		}
	}
	if r.Compared > 0 {
		r.OverPct = 100 * float64(r.Over) / float64(r.Compared)
		r.MeanDelta = float64(sum) / float64(r.Compared)
	}
	if o.ShiftTilePt > 0 && o.ShiftMaxPx > 0 {
		tile := int(math.Round(o.ShiftTilePt * float64(r.Scale)))
		for _, s := range shifted(lumaPlane(rp), lumaPlane(gp), masked, w, tile, o.ShiftMaxPx) {
			s.XPt /= float64(r.Scale)
			s.YPt = s.YPt/float64(r.Scale) + o.CropTopPt
			r.Shifted = append(r.Shifted, s)
		}
	}
	return r, diff, nil
}

// plane is one value per pixel, row-major.
type plane struct {
	w, h int
	v    []float64
}

// lumaPlane is img's Rec. 601 luma.
func lumaPlane(img *image.RGBA) plane {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	p := plane{w, h, make([]float64, w*h)}
	for y := range h {
		row := img.Pix[y*img.Stride:]
		for x := range w {
			p.v[y*w+x] = 0.299*float64(row[x*4]) + 0.587*float64(row[x*4+1]) + 0.114*float64(row[x*4+2])
		}
	}
	return p
}

// The displacement scan's thresholds, on 8-bit luma. A tile with less
// detail than flatStd has nothing to line up by. A tile is displaced when,
// unmoved, it is off by more than minMean on average and some move fits it
// to within shiftGain of that: anti-aliasing and glyph-shape differences
// change pixels in place, and no move removes most of them, while content
// drawn a pixel off is fitted almost exactly by moving it back.
const (
	flatStd   = 4.0
	minMean   = 1.0
	shiftGain = 0.6
)

// shifted scans ref and got (the same scale, top-left aligned) in tile×tile
// squares from the top-left, leaving out squares with any masked pixel (mask
// is maskW wide). For each square with detail that differs, it tries every
// move of got up to maxPx in x and y that stays inside got, and reports the
// squares where a move fits (Shift.XPt and YPt in compared pixels here).
// Only squares that already differ are searched, so a wide maxPx costs
// little on a close capture.
func shifted(ref, got plane, mask []bool, maskW, tile, maxPx int) []Shift {
	var out []Shift
	w, h := min(ref.w, got.w), min(ref.h, got.h)
	meanDiff := func(x0, y0, dx, dy int) float64 {
		var s float64
		for y := y0; y < y0+tile; y++ {
			r, g := ref.v[y*ref.w+x0:], got.v[(y+dy)*got.w+x0+dx:]
			for x := range tile {
				s += math.Abs(r[x] - g[x])
			}
		}
		return s / float64(tile*tile)
	}
	for y0 := 0; y0+tile <= h; y0 += tile {
	tiles:
		for x0 := 0; x0+tile <= w; x0 += tile {
			var sum, sq float64
			for y := y0; y < y0+tile; y++ {
				for x := x0; x < x0+tile; x++ {
					if mask[y*maskW+x] {
						continue tiles
					}
					v := ref.v[y*ref.w+x]
					sum += v
					sq += v * v
				}
			}
			n := float64(tile * tile)
			if mean := sum / n; sq/n-mean*mean < flatStd*flatStd {
				continue
			}
			e0 := meanDiff(x0, y0, 0, 0)
			if e0 <= minMean {
				continue
			}
			best := Shift{XPt: float64(x0), YPt: float64(y0), Mean: e0, Best: e0}
			for dy := max(-maxPx, -y0); dy <= min(maxPx, got.h-tile-y0); dy++ {
				for dx := max(-maxPx, -x0); dx <= min(maxPx, got.w-tile-x0); dx++ {
					if dx == 0 && dy == 0 {
						continue
					}
					if e := meanDiff(x0, y0, dx, dy); e < best.Best {
						best.Best, best.Dx, best.Dy = e, dx, dy
					}
				}
			}
			if best.Best < shiftGain*e0 {
				out = append(out, best)
			}
		}
	}
	return out
}

func absDiff(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

// luma is a rough brightness of whichever pixel there is, for the diff
// picture's background.
func luma(a, b []uint8) uint8 {
	p := a
	if p == nil {
		p = b
	}
	if p == nil {
		return 0
	}
	return uint8((int(p[0])*3 + int(p[1])*6 + int(p[2])) / 10)
}

// toRGBA copies the part r of img into a new RGBA picture at the origin.
// RGBA is premultiplied, so this composites over black.
func toRGBA(img image.Image, r image.Rectangle) *image.RGBA {
	out := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	draw.Draw(out, out.Rect, image.NewUniform(color.Black), image.Point{}, draw.Src)
	draw.Draw(out, out.Rect, img, r.Min, draw.Over)
	return out
}

// downscale box-filters img by the whole factor k: each output pixel is
// the mean of a k×k block, rounded to the nearest value. A trailing
// partial block is dropped.
func downscale(img *image.RGBA, k int) *image.RGBA {
	if k == 1 {
		return img
	}
	w, h := img.Rect.Dx()/k, img.Rect.Dy()/k
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	n := k * k
	for y := range h {
		for x := range w {
			var s [4]int
			for dy := range k {
				row := img.Pix[(y*k+dy)*img.Stride+x*k*4:]
				for dx := range k {
					for c := range 4 {
						s[c] += int(row[dx*4+c])
					}
				}
			}
			o := out.Pix[y*out.Stride+x*4:]
			for c := range 4 {
				o[c] = uint8((s[c] + n/2) / n)
			}
		}
	}
	return out
}

// maskBits marks the pixels any rect covers, at scale pixels per point,
// after the crop. A rect covers every pixel it touches.
func maskBits(rects []Rect, w, h int, scale, cropTopPt float64) []bool {
	bits := make([]bool, w*h)
	for _, m := range rects {
		x0 := max(0, int(math.Floor(m.X*scale)))
		x1 := min(w, int(math.Ceil((m.X+m.W)*scale)))
		y0 := max(0, int(math.Floor((m.Y-cropTopPt)*scale)))
		y1 := min(h, int(math.Ceil((m.Y+m.H-cropTopPt)*scale)))
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				bits[y*w+x] = true
			}
		}
	}
	return bits
}

// pngColor names a PNG's colour chunks (sRGB, iCCP with its profile name,
// gAMA, cHRM); "none" means untagged. Go's decoder ignores them, so the
// pixels are compared as stored.
func pngColor(data []byte) string {
	const sig = "\x89PNG\r\n\x1a\n"
	if !bytes.HasPrefix(data, []byte(sig)) {
		return "not a PNG"
	}
	var out []string
	for p := len(sig); p+8 <= len(data); {
		n := int(binary.BigEndian.Uint32(data[p:]))
		typ := string(data[p+4 : p+8])
		body := data[p+8 : min(len(data), p+8+n)]
		switch typ {
		case "sRGB", "gAMA", "cHRM":
			out = append(out, typ)
		case "iCCP":
			name, _, _ := bytes.Cut(body, []byte{0})
			out = append(out, fmt.Sprintf("iCCP %q", name))
		case "IDAT", "IEND":
			p = len(data)
			continue
		}
		p += 12 + n
	}
	if len(out) == 0 {
		return "none"
	}
	return fmt.Sprint(out)
}
