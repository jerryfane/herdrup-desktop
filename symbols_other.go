//go:build !darwin

package main

import (
	"embed"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// Apple licenses SF Symbols for its own platforms only, so Windows and
// Linux draw each symbol the page uses with the nearest Phosphor icon
// (third_party/phosphor: @phosphor-icons/core 2.1.1, MIT). The icon's ink
// is fitted to the box where macOS draws the symbol's ink, from
// sfMetrics, in a box of the size macOS gives the symbol.
//
//go:embed third_party/phosphor
var phosphor embed.FS

// phosphorWeights is the Phosphor weight drawn for each SF weight, by
// symbolWeight: the stroke is fitted with the ink, so these follow SF's
// stroke widths, not the names.
var phosphorWeights = [len(symbolWeights)]string{"thin", "thin", "light", "regular", "regular", "bold", "bold", "bold", "bold"}

// file is the Phosphor SVG drawn for s at SF weight w.
func (s standIn) file(w symbolWeight) string {
	if s.solid {
		return "third_party/phosphor/fill/" + s.icon + "-fill.svg"
	}
	if pw := phosphorWeights[w]; pw != "regular" {
		return "third_party/phosphor/" + pw + "/" + s.icon + "-" + pw + ".svg"
	}
	return "third_party/phosphor/regular/" + s.icon + ".svg"
}

func drawSymbol(name string, pointSize float64, w symbolWeight, _ int) (SymbolImage, error) {
	si := slices.IndexFunc(standIns[:], func(s standIn) bool { return s.symbol == name })
	mi := slices.IndexFunc(sfMetrics[:], func(m sfMetric) bool { return m.symbol == name })
	if si < 0 || mi < 0 {
		return SymbolImage{}, fmt.Errorf("symbols: no stand-in for SF Symbol %q", name)
	}
	box := sfMetrics[mi].weights[w]
	file := standIns[si].file(w)
	src, err := phosphor.ReadFile(file)
	if err != nil {
		return SymbolImage{}, fmt.Errorf("symbols: %w", err)
	}
	d, err := svgPath(string(src))
	if err != nil {
		return SymbolImage{}, fmt.Errorf("symbols: %s: %w", file, err)
	}
	ink, err := pathBounds(d)
	if err != nil {
		return SymbolImage{}, fmt.Errorf("symbols: %s: %w", file, err)
	}

	// Scale the icon's ink into the symbol's, keeping its aspect, and
	// centre it there.
	width, height := box.width*pointSize, box.height*pointSize
	k := math.Min((box.right-box.left)/(ink[2]-ink[0]), (box.bottom-box.top)/(ink[3]-ink[1])) * pointSize
	vx := (ink[0]+ink[2])/2 - (box.left+box.right)/2*pointSize/k
	vy := (ink[1]+ink[3])/2 - (box.top+box.bottom)/2*pointSize/k
	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="%s %s %s %s"><path fill="#fff" d="%s"/></svg>`,
		num(width), num(height), num(vx), num(vy), num(width/k), num(height/k), d)
	return SymbolImage{
		DataURL:  "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg)),
		Width:    width,
		Height:   height,
		Baseline: box.baseline * pointSize,
	}, nil
}

func num(v float64) string { return strconv.FormatFloat(math.Round(v*1e4)/1e4, 'f', -1, 64) }

// svgPath returns the d attribute of the one path in a Phosphor SVG.
func svgPath(svg string) (string, error) {
	_, rest, ok := strings.Cut(svg, "<path")
	if !ok || strings.Contains(rest, "<path") {
		return "", errors.New("want exactly one path")
	}
	_, d, ok := strings.Cut(rest, ` d="`)
	if !ok {
		return "", errors.New("path has no d")
	}
	d, _, ok = strings.Cut(d, `"`)
	if !ok {
		return "", errors.New("path's d is not closed")
	}
	return d, nil
}

// pathBounds returns the bounds [minX, minY, maxX, maxY] of the outline
// an SVG path draws. Curves and arcs are measured at 64 points each, which
// is within 0.05 units for Phosphor's 256-unit icons.
func pathBounds(d string) ([4]float64, error) {
	b := [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	add := func(x, y float64) {
		b[0], b[1] = math.Min(b[0], x), math.Min(b[1], y)
		b[2], b[3] = math.Max(b[2], x), math.Max(b[3], y)
	}
	const steps = 64
	p := pathScanner{s: d}
	var (
		cmd                 byte
		x, y, sx, sy        float64
		cx, cy              float64 // last control point, for S and T
		prevCubic, prevQuad bool
	)
	for {
		c, ok := p.command()
		if !ok {
			break
		}
		if c != 0 {
			cmd = c
		} else if cmd == 0 || cmd == 'Z' || cmd == 'z' {
			return b, fmt.Errorf("number without a command at %d", p.i)
		}
		rel := cmd >= 'a'
		ox, oy := 0.0, 0.0
		if rel {
			ox, oy = x, y
		}
		var nums [7]float64
		// The numbers each command takes, by "MLHVCSQTAZ".
		need := [...]int{2, 2, 1, 1, 6, 4, 4, 2, 7, 0}[strings.IndexByte("MLHVCSQTAZ", cmd&^0x20)]
		for i := range need {
			v, err := p.number(cmd&^0x20 == 'A' && (i == 3 || i == 4))
			if err != nil {
				return b, err
			}
			nums[i] = v
		}
		cubic, quad := false, false
		switch cmd &^ 0x20 {
		case 'M':
			x, y = ox+nums[0], oy+nums[1]
			sx, sy = x, y
			add(x, y)
			// Further pairs after a moveto are linetos.
			if rel {
				cmd = 'l'
			} else {
				cmd = 'L'
			}
		case 'L':
			x, y = ox+nums[0], oy+nums[1]
			add(x, y)
		case 'H':
			x = ox + nums[0]
			add(x, y)
		case 'V':
			y = oy + nums[0]
			add(x, y)
		case 'C', 'S':
			var x1, y1, x2, y2, ex, ey float64
			if cmd&^0x20 == 'C' {
				x1, y1, x2, y2, ex, ey = ox+nums[0], oy+nums[1], ox+nums[2], oy+nums[3], ox+nums[4], oy+nums[5]
			} else {
				x1, y1 = x, y
				if prevCubic {
					x1, y1 = 2*x-cx, 2*y-cy
				}
				x2, y2, ex, ey = ox+nums[0], oy+nums[1], ox+nums[2], oy+nums[3]
			}
			for i := 1; i <= steps; i++ {
				t := float64(i) / steps
				u := 1 - t
				add(u*u*u*x+3*u*u*t*x1+3*u*t*t*x2+t*t*t*ex, u*u*u*y+3*u*u*t*y1+3*u*t*t*y2+t*t*t*ey)
			}
			cx, cy, x, y, cubic = x2, y2, ex, ey, true
		case 'Q', 'T':
			var x1, y1, ex, ey float64
			if cmd&^0x20 == 'Q' {
				x1, y1, ex, ey = ox+nums[0], oy+nums[1], ox+nums[2], oy+nums[3]
			} else {
				x1, y1 = x, y
				if prevQuad {
					x1, y1 = 2*x-cx, 2*y-cy
				}
				ex, ey = ox+nums[0], oy+nums[1]
			}
			for i := 1; i <= steps; i++ {
				t := float64(i) / steps
				u := 1 - t
				add(u*u*x+2*u*t*x1+t*t*ex, u*u*y+2*u*t*y1+t*t*ey)
			}
			cx, cy, x, y, quad = x1, y1, ex, ey, true
		case 'A':
			ex, ey := ox+nums[5], oy+nums[6]
			arcPoints(x, y, nums[0], nums[1], nums[2], nums[3] != 0, nums[4] != 0, ex, ey, steps, add)
			x, y = ex, ey
		case 'Z':
			x, y = sx, sy
		}
		prevCubic, prevQuad = cubic, quad
	}
	if math.IsInf(b[0], 0) {
		return b, errors.New("empty path")
	}
	return b, nil
}

// arcPoints calls add with points along an SVG elliptical arc from
// (x1, y1) to (x2, y2), converted to its centre as in SVG 1.1 F.6.5.
func arcPoints(x1, y1, rx, ry, angle float64, large, sweep bool, x2, y2 float64, steps int, add func(x, y float64)) {
	rx, ry = math.Abs(rx), math.Abs(ry)
	if rx == 0 || ry == 0 || (x1 == x2 && y1 == y2) {
		add(x2, y2)
		return
	}
	phi := angle * math.Pi / 180
	cos, sin := math.Cos(phi), math.Sin(phi)
	dx, dy := (x1-x2)/2, (y1-y2)/2
	x1p, y1p := cos*dx+sin*dy, -sin*dx+cos*dy
	if l := x1p*x1p/(rx*rx) + y1p*y1p/(ry*ry); l > 1 {
		rx, ry = rx*math.Sqrt(l), ry*math.Sqrt(l)
	}
	num := rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p
	den := rx*rx*y1p*y1p + ry*ry*x1p*x1p
	f := math.Sqrt(math.Max(0, num/den))
	if large == sweep {
		f = -f
	}
	cxp, cyp := f*rx*y1p/ry, -f*ry*x1p/rx
	cx, cy := cos*cxp-sin*cyp+(x1+x2)/2, sin*cxp+cos*cyp+(y1+y2)/2
	theta := math.Atan2((y1p-cyp)/ry, (x1p-cxp)/rx)
	delta := math.Atan2((-y1p-cyp)/ry, (-x1p-cxp)/rx) - theta
	if sweep && delta < 0 {
		delta += 2 * math.Pi
	} else if !sweep && delta > 0 {
		delta -= 2 * math.Pi
	}
	for i := 1; i <= steps; i++ {
		a := theta + delta*float64(i)/float64(steps)
		ex, ey := rx*math.Cos(a), ry*math.Sin(a)
		add(cos*ex-sin*ey+cx, sin*ex+cos*ey+cy)
	}
}

// pathScanner reads the commands and numbers of SVG path data.
type pathScanner struct {
	s string
	i int
}

func (p *pathScanner) skip() {
	for p.i < len(p.s) && (p.s[p.i] == ' ' || p.s[p.i] == ',' || p.s[p.i] == '\t' || p.s[p.i] == '\n' || p.s[p.i] == '\r') {
		p.i++
	}
}

// command returns the next command letter, 0 when a number follows
// instead, and false at the end.
func (p *pathScanner) command() (byte, bool) {
	p.skip()
	if p.i == len(p.s) {
		return 0, false
	}
	if c := p.s[p.i]; strings.IndexByte("MmLlHhVvCcSsQqTtAaZz", c) >= 0 {
		p.i++
		return c, true
	}
	return 0, true
}

// number reads a number, or with flag an arc flag, which may run into
// what follows it ("a8 8 0 018-8").
func (p *pathScanner) number(flag bool) (float64, error) {
	p.skip()
	start := p.i
	if flag {
		if p.i < len(p.s) && (p.s[p.i] == '0' || p.s[p.i] == '1') {
			p.i++
			return float64(p.s[start] - '0'), nil
		}
		return 0, fmt.Errorf("want an arc flag at %d", start)
	}
	if p.i < len(p.s) && (p.s[p.i] == '-' || p.s[p.i] == '+') {
		p.i++
	}
	dot, exp := false, false
scan:
	for ; p.i < len(p.s); p.i++ {
		switch c := p.s[p.i]; {
		case c >= '0' && c <= '9':
		case c == '.' && !dot && !exp:
			dot = true
		case (c == 'e' || c == 'E') && !exp:
			exp = true
			if p.i+1 < len(p.s) && (p.s[p.i+1] == '-' || p.s[p.i+1] == '+') {
				p.i++
			}
		default:
			break scan
		}
	}
	v, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil {
		return 0, fmt.Errorf("bad number at %d: %q", start, p.s[start:p.i])
	}
	return v, nil
}
