package main

import (
	"fmt"
	"sync"
)

// SymbolImage is a symbol drawn for the page: a white glyph on a
// transparent ground, a template the page tints with CSS mask-image and
// background-color. Lengths are in points, which are CSS pixels.
type SymbolImage struct {
	// DataURL is the glyph filling the Width by Height box: on macOS a PNG
	// of Width·scale by Height·scale pixels drawn by AppKit, on Windows
	// and Linux an SVG. Show it as a Width by Height element with
	// mask-image: url(DataURL) and mask-size: 100% 100%.
	DataURL string `json:"dataURL"`
	// Width and Height are the frame SwiftUI gives
	// Image(systemName:).font(.system(size:weight:)) on a display of the
	// scale asked for, in whole pixels of it: the box SwiftUI centres in a
	// .frame or lines up in a stack.
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	// Baseline is the height of the symbol's text baseline above the
	// bottom of the box, where SwiftUI's .firstTextBaseline alignment puts
	// the baseline of text beside it. vertical-align: -Baseline (px) on
	// an inline element puts it there.
	Baseline float64 `json:"baseline"`
}

// Symbols draws SF Symbols for the page: the real ones on macOS, the
// nearest open icons on Windows and Linux.
type Symbols struct{}

// Image draws the SF Symbol name as SwiftUI draws
// Image(systemName: name).font(.system(size: pointSize, weight: weight)).
// weight is a SwiftUI Font.Weight name (ultraLight, thin, light, regular,
// medium, semibold, bold, heavy, black) and scale the pixels per point, 1
// to 3. Results are cached.
func (Symbols) Image(name string, pointSize float64, weight string, scale int) (SymbolImage, error) {
	w, ok := parseSymbolWeight(weight)
	if !ok {
		return SymbolImage{}, fmt.Errorf("symbols: unknown weight %q", weight)
	}
	if name == "" {
		return SymbolImage{}, fmt.Errorf("symbols: no symbol name")
	}
	if !(pointSize > 0 && pointSize <= maxSymbolPointSize) {
		return SymbolImage{}, fmt.Errorf("symbols: point size %v is not in (0, %v]", pointSize, maxSymbolPointSize)
	}
	if scale < 1 || scale > 3 {
		return SymbolImage{}, fmt.Errorf("symbols: scale %d is not 1, 2 or 3", scale)
	}
	key := symbolKey{name, pointSize, w, scale}
	symbolCache.Lock()
	img, ok := symbolCache.m[key]
	symbolCache.Unlock()
	if ok {
		return img, nil
	}
	img, err := drawSymbol(name, pointSize, w, scale)
	if err != nil {
		return SymbolImage{}, err
	}
	symbolCache.Lock()
	symbolCache.m[key] = img
	symbolCache.Unlock()
	return img, nil
}

// maxSymbolPointSize bounds the bitmap a call can ask for.
const maxSymbolPointSize = 512

// symbolWeight indexes symbolWeights.
type symbolWeight int8

// symbolWeights are SwiftUI's Font.Weight names, lightest first.
var symbolWeights = [...]string{"ultraLight", "thin", "light", "regular", "medium", "semibold", "bold", "heavy", "black"}

func parseSymbolWeight(s string) (symbolWeight, bool) {
	for i, n := range symbolWeights {
		if n == s {
			return symbolWeight(i), true
		}
	}
	return 0, false
}

func (w symbolWeight) String() string { return symbolWeights[w] }

type symbolKey struct {
	name   string
	size   float64
	weight symbolWeight
	scale  int
}

var symbolCache = struct {
	sync.Mutex
	m map[symbolKey]SymbolImage
}{m: map[symbolKey]SymbolImage{}}

// standIn is an SF Symbol the page uses and the Phosphor icon drawn for it
// on Windows and Linux (symbols_other.go). A solid stand-in has a single
// weight, Phosphor's fill.
type standIn struct {
	symbol, icon string
	solid        bool
}

var standIns = [...]standIn{
	{"chevron.left", "caret-left", false},
	{"chevron.right", "caret-right", false},
	{"chevron.down", "caret-down", false},
	{"chevron.up", "caret-up", false},
	{"sidebar.leading", "sidebar", false},
	{"terminal", "terminal-window", false},
	{"plus", "plus", false},
	{"magnifyingglass", "magnifying-glass", false},
	{"xmark.circle.fill", "x-circle", true},
	{"exclamationmark", "exclamation-mark", false},
	{"questionmark", "question-mark", false},
	{"xmark", "x", false},
	{"wifi.slash", "wifi-slash", false},
	{"star.fill", "star", true},
	{"archivebox.fill", "archive", true},
	{"square.grid.2x2.fill", "squares-four", true},
	{"bubble.left.and.bubble.right.fill", "chats", true},
	{"gearshape.fill", "gear", true},
	// Gram (herdrup App/GramView.swift, GramCards.swift, HerdrApp.swift
	// gramSidebar, ComposerAttach.swift).
	{"envelope.open", "envelope-open", false},
	{"arrow.clockwise", "arrow-clockwise", false},
	{"bookmark", "bookmark-simple", false},
	{"bookmark.fill", "bookmark-simple", true},
	{"arrow.up", "arrow-up", false},
	{"doc.on.doc", "copy", false},
	{"checkmark", "check", false},
	{"photo", "image", false},
	{"clock.badge.xmark", "clock", false},
	{"tray", "tray", false},
	{"exclamationmark.triangle", "warning", false},
	{"bubble.left.and.exclamationmark.bubble.right", "chats", false},
	{"paperclip", "paperclip", false},
	{"tray.and.arrow.down", "tray-arrow-down", false},
}

// sfMetric is how macOS lays out one stand-in's SF Symbol at each weight
// (symbols_sfmetrics.go), so that Windows and Linux put their icons in
// the same boxes.
type sfMetric struct {
	symbol  string
	weights [len(symbolWeights)]sfBox
}

// sfBox is a SymbolImage's Width, Height and Baseline and the bounds of
// its ink from the box's top-left corner, all per point of size.
type sfBox struct {
	width, height, baseline  float64
	left, top, right, bottom float64
}
