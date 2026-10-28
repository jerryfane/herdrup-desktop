//go:build darwin

package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/png"
	"math"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// On macOS the symbols are Apple's own, drawn by AppKit at run time: SF
// Symbols are licensed for Apple platforms only, so no artwork of them is
// in this repository or in any build.

type nsPoint struct{ X, Y float64 }
type nsSize struct{ Width, Height float64 }
type nsRect struct {
	Origin nsPoint
	Size   nsSize
}

// appKit holds what drawSymbol needs from the Objective-C runtime and
// AppKit, loaded once.
var appKit struct {
	once sync.Once
	err  error
	// mu serialises drawing: bound methods run on their own goroutines.
	mu sync.Mutex

	msgSend           uintptr
	poolPush, poolPop uintptr
	// weights are AppKit's NSFontWeight constants, by symbolWeight.
	weights [len(symbolWeights)]float64

	// Typed objc_msgSend for float and struct arguments and results.
	config     func(cls objc.ID, sel objc.SEL, size, weight float64, scale int) objc.ID
	size       func(obj objc.ID, sel objc.SEL) nsSize
	rect       func(obj objc.ID, sel objc.SEL) nsRect
	setSize    func(obj objc.ID, sel objc.SEL, s nsSize)
	draw       func(obj objc.ID, sel objc.SEL, dst, src nsRect, op uint, fraction float64)
	initBitmap func(obj objc.ID, sel objc.SEL, planes uintptr, width, height, bitsPerSample, samplesPerPixel int, alpha, planar bool, colorSpace objc.ID, bytesPerRow, bitsPerPixel int) objc.ID
}

func loadAppKit() error {
	appKit.once.Do(func() { appKit.err = openAppKit() })
	return appKit.err
}

func openAppKit() error {
	libobjc, err := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	if err != nil {
		return fmt.Errorf("symbols: %w", err)
	}
	lib, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	if err != nil {
		return fmt.Errorf("symbols: %w", err)
	}
	sym := func(lib uintptr, name string) uintptr {
		p, e := purego.Dlsym(lib, name)
		if e != nil && err == nil {
			err = fmt.Errorf("symbols: %w", e)
		}
		return p
	}
	appKit.msgSend = sym(libobjc, "objc_msgSend")
	// A struct result larger than 16 bytes comes back through memory on
	// amd64, by objc_msgSend_stret.
	stret := appKit.msgSend
	if runtime.GOARCH == "amd64" {
		stret = sym(libobjc, "objc_msgSend_stret")
	}
	appKit.poolPush = sym(libobjc, "objc_autoreleasePoolPush")
	appKit.poolPop = sym(libobjc, "objc_autoreleasePoolPop")
	for i, n := range [...]string{"UltraLight", "Thin", "Light", "Regular", "Medium", "Semibold", "Bold", "Heavy", "Black"} {
		if p := sym(lib, "NSFontWeight"+n); p != 0 {
			appKit.weights[i] = **(**float64)(unsafe.Pointer(&p))
		}
	}
	if err != nil {
		return err
	}
	if objc.GetClass("NSImageSymbolConfiguration") == 0 {
		return errors.New("symbols: SF Symbols need macOS 11 or later")
	}
	purego.RegisterFunc(&appKit.config, appKit.msgSend)
	purego.RegisterFunc(&appKit.size, appKit.msgSend)
	purego.RegisterFunc(&appKit.rect, stret)
	purego.RegisterFunc(&appKit.setSize, appKit.msgSend)
	purego.RegisterFunc(&appKit.draw, appKit.msgSend)
	purego.RegisterFunc(&appKit.initBitmap, appKit.msgSend)
	return nil
}

// msg sends a message whose arguments are integers or pointers. Go
// pointers converted in the call stay put until it returns.
//
//go:uintptrescapes
func msg(obj objc.ID, selector string, args ...uintptr) objc.ID {
	var a [8]uintptr
	a[0], a[1] = uintptr(obj), uintptr(objc.RegisterName(selector))
	n := copy(a[2:], args)
	r, _, _ := purego.SyscallN(appKit.msgSend, a[:n+2]...)
	return objc.ID(r)
}

func class(name string) objc.ID { return objc.ID(objc.GetClass(name)) }

func sel(name string) objc.SEL { return objc.RegisterName(name) }

// withPool runs fn in an autorelease pool on one thread.
func withPool(fn func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool, _, _ := purego.SyscallN(appKit.poolPush)
	defer purego.SyscallN(appKit.poolPop, pool)
	fn()
}

// nsString returns an autoreleased NSString.
func nsString(s string) objc.ID {
	const utf8 = 4 // NSUTF8StringEncoding
	str := msg(msg(class("NSString"), "alloc"), "initWithBytes:length:encoding:",
		uintptr(unsafe.Pointer(unsafe.StringData(s))), uintptr(len(s)), utf8)
	runtime.KeepAlive(s)
	return msg(str, "autorelease")
}

// symbolMetrics is an SF Symbol image's layout in points: its size and
// the height of its baseline above its bottom edge.
type symbolMetrics struct {
	size     nsSize
	baseline float64
}

// sfSymbol returns the autoreleased NSImage of the SF Symbol name at
// pointSize and weight w, at the default (medium) image scale, as
// Image(systemName:).font(.system(size:weight:)) asks for it. It must run
// in a pool.
func sfSymbol(name string, pointSize float64, w symbolWeight) (objc.ID, error) {
	base := msg(class("NSImage"), "imageWithSystemSymbolName:accessibilityDescription:", uintptr(nsString(name)), 0)
	if base == 0 {
		return 0, fmt.Errorf("symbols: no SF Symbol named %q", name)
	}
	const medium = 2 // NSImageSymbolScaleMedium
	cfg := appKit.config(class("NSImageSymbolConfiguration"), sel("configurationWithPointSize:weight:scale:"), pointSize, appKit.weights[w], medium)
	img := msg(base, "imageWithSymbolConfiguration:", uintptr(cfg))
	if img == 0 {
		return 0, fmt.Errorf("symbols: cannot configure %q at %vpt %s", name, pointSize, w)
	}
	return img, nil
}

// measureSymbol reads img's size and baseline. NSImage has no baseline
// property: a symbol image's alignment rect starts at its baseline.
func measureSymbol(img objc.ID) symbolMetrics {
	return symbolMetrics{
		size:     appKit.size(img, sel("size")),
		baseline: appKit.rect(img, sel("alignmentRect")).Origin.Y,
	}
}

func responds(obj objc.ID, selector string) bool {
	return obj != 0 && msg(obj, "respondsToSelector:", uintptr(sel(selector)))&0xff != 0
}

// glyphRects returns the alignment rect of img's glyph in the image, in
// AppKit's coordinates (y up), as CoreUI rounds it to whole points and
// unrounded. AppKit draws the glyph's unrounded rect with its bottom-left
// corner at the rounded rect's; SwiftUI draws it with its top-left corner
// at the rounded rect's. CoreUI's vector glyph is private API: ok is false
// when it is missing.
func glyphRects(img objc.ID) (rounded, exact nsRect, ok bool) {
	reps := msg(img, "representations")
	if reps == 0 || msg(reps, "count") == 0 {
		return rounded, exact, false
	}
	rep := msg(reps, "objectAtIndex:", 0)
	if !responds(rep, "vectorGlyph") {
		return rounded, exact, false
	}
	g := msg(rep, "vectorGlyph")
	if !responds(g, "alignmentRect") || !responds(g, "alignmentRectUnrounded") {
		return rounded, exact, false
	}
	rounded, exact = appKit.rect(g, sel("alignmentRect")), appKit.rect(g, sel("alignmentRectUnrounded"))
	return rounded, exact, exact.Size.Height > 0 && exact.Size.Height <= rounded.Size.Height
}

// rasterSymbol draws img at its size, one pixel per point, with its
// bottom-left corner at origin in a transparent pw by ph bitmap (y up),
// and returns the coverage: one alpha byte per pixel, rows from the top.
// It must run in a pool.
func rasterSymbol(img objc.ID, size nsSize, pw, ph int, origin nsPoint) (*image.Alpha, error) {
	if pw <= 0 || ph <= 0 {
		return nil, errors.New("symbols: empty symbol image")
	}
	rep := appKit.initBitmap(msg(class("NSBitmapImageRep"), "alloc"),
		sel("initWithBitmapDataPlanes:pixelsWide:pixelsHigh:bitsPerSample:samplesPerPixel:hasAlpha:isPlanar:colorSpaceName:bytesPerRow:bitsPerPixel:"),
		0, pw, ph, 8, 4, true, false, nsString("NSDeviceRGBColorSpace"), 0, 32)
	if rep == 0 {
		return nil, errors.New("symbols: cannot make a bitmap")
	}
	msg(rep, "autorelease")
	ctx := msg(class("NSGraphicsContext"), "graphicsContextWithBitmapImageRep:", uintptr(rep))
	if ctx == 0 {
		return nil, errors.New("symbols: cannot draw into a bitmap")
	}
	gc := class("NSGraphicsContext")
	msg(gc, "saveGraphicsState")
	msg(gc, "setCurrentContext:", uintptr(ctx))
	const sourceOver = 2 // NSCompositingOperationSourceOver
	appKit.draw(img, sel("drawInRect:fromRect:operation:fraction:"), nsRect{Origin: origin, Size: size}, nsRect{}, sourceOver, 1)
	msg(ctx, "flushGraphics")
	msg(gc, "restoreGraphicsState")

	const alphaFirst = 1 // NSBitmapFormatAlphaFirst
	data := msg(rep, "bitmapData")
	stride := int(msg(rep, "bytesPerRow"))
	if data == 0 || int(msg(rep, "bitsPerPixel")) != 32 || stride < 4*pw {
		return nil, errors.New("symbols: unexpected bitmap layout")
	}
	off := 3
	if int(msg(rep, "bitmapFormat"))&alphaFirst != 0 {
		off = 0
	}
	px := unsafe.Slice(*(**byte)(unsafe.Pointer(&data)), stride*ph)
	a := image.NewAlpha(image.Rect(0, 0, pw, ph))
	for y := range ph {
		row := px[y*stride:]
		for x := range pw {
			a.Pix[y*a.Stride+x] = row[4*x+off]
		}
	}
	return a, nil
}

// shrink averages n by n blocks of a.
func shrink(a *image.Alpha, n int) *image.Alpha {
	w, h := a.Rect.Dx()/n, a.Rect.Dy()/n
	out := image.NewAlpha(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			sum := 0
			for yy := y * n; yy < y*n+n; yy++ {
				for _, v := range a.Pix[yy*a.Stride+x*n : yy*a.Stride+x*n+n] {
					sum += int(v)
				}
			}
			out.Pix[y*out.Stride+x] = uint8((sum + n*n/2) / (n * n))
		}
	}
	return out
}

// maxSuperSample and maxSuperPixels bound drawSymbol's supersampling: a
// glyph is placed to 1/maxSuperSample pixel, in a bitmap of at most
// maxSuperPixels on a side.
const maxSuperSample, maxSuperPixels = 8, 2048

// rasterLikeSwiftUI draws img, a symbol image at size points, where
// SwiftUI draws it in a box of its size: AppKit puts the glyph's
// unrounded alignment rect on the bottom of the rounded one, SwiftUI on
// its top, up to a pixel higher. It draws the symbol n times larger with
// the glyph moved there and averages it down. It must run in a pool.
func rasterLikeSwiftUI(img objc.ID, name string, size float64, w symbolWeight, box nsSize) (*image.Alpha, error) {
	pw, ph := int(math.Ceil(box.Width-1e-6)), int(math.Ceil(box.Height-1e-6))
	rounded, exact, ok := glyphRects(img)
	n := min(maxSuperSample, maxSuperPixels/max(pw, ph, 1))
	if !ok || n < 2 {
		// AppKit's placement, at most a pixel lower than SwiftUI's.
		return rasterSymbol(img, box, pw, ph, nsPoint{0, float64(ph) - box.Height})
	}
	big, err := sfSymbol(name, size*float64(n), w)
	if err != nil {
		return nil, err
	}
	bigRounded, _, ok := glyphRects(big)
	if !ok {
		return rasterSymbol(img, box, pw, ph, nsPoint{0, float64(ph) - box.Height})
	}
	k := float64(n)
	// The glyph's left edge on the rounded rect's, its top on the rounded
	// rect's top, in the n× bitmap whose top edge is the box's.
	top := float64(ph) - box.Height
	origin := nsPoint{
		X: k*rounded.Origin.X - bigRounded.Origin.X,
		Y: math.Round(k*(top+rounded.Origin.Y+rounded.Size.Height-exact.Size.Height) - bigRounded.Origin.Y),
	}
	a, err := rasterSymbol(big, appKit.size(big, sel("size")), n*pw, n*ph, origin)
	if err != nil {
		return nil, err
	}
	return shrink(a, n), nil
}

// whitePNG encodes coverage as a white glyph on transparent.
func whitePNG(a *image.Alpha) ([]byte, error) {
	img := image.NewNRGBA(a.Bounds())
	for i, v := range a.Pix {
		p := img.Pix[4*i : 4*i+4]
		p[0], p[1], p[2], p[3] = 0xff, 0xff, 0xff, v
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// drawSymbol lays the symbol out at pointSize×scale on AppKit's
// whole-point grid, one pixel per point: that is the symbol at pointSize
// on the 1/scale point grid of a scale× display, where SwiftUI lays it
// out.
func drawSymbol(name string, pointSize float64, w symbolWeight, scale int) (SymbolImage, error) {
	if err := loadAppKit(); err != nil {
		return SymbolImage{}, err
	}
	var (
		m   symbolMetrics
		a   *image.Alpha
		err error
	)
	size := pointSize * float64(scale)
	appKit.mu.Lock()
	withPool(func() {
		var img objc.ID
		if img, err = sfSymbol(name, size, w); err != nil {
			return
		}
		m = measureSymbol(img)
		a, err = rasterLikeSwiftUI(img, name, size, w, m.size)
	})
	appKit.mu.Unlock()
	if err != nil {
		return SymbolImage{}, err
	}
	data, err := whitePNG(a)
	if err != nil {
		return SymbolImage{}, err
	}
	s := float64(scale)
	return SymbolImage{
		DataURL:  "data:image/png;base64," + base64.StdEncoding.EncodeToString(data),
		Width:    float64(a.Rect.Dx()) / s,
		Height:   float64(a.Rect.Dy()) / s,
		Baseline: m.baseline / s,
	}, nil
}
