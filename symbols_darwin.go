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

// rasterSymbol draws img at its size into a transparent bitmap of one
// pixel per point, its size rounded up to whole pixels with the image at
// the top-left, and returns the coverage: one alpha byte per pixel, rows
// from the top. It must run in a pool.
func rasterSymbol(img objc.ID, size nsSize) (*image.Alpha, error) {
	pw, ph := int(math.Ceil(size.Width-1e-6)), int(math.Ceil(size.Height-1e-6))
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
	// AppKit's y axis points up: the image's top edge on the bitmap's.
	dst := nsRect{Origin: nsPoint{0, float64(ph) - size.Height}, Size: size}
	appKit.draw(img, sel("drawInRect:fromRect:operation:fraction:"), dst, nsRect{}, sourceOver, 1)
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

// drawSymbol draws the symbol at pointSize×scale on AppKit's whole-point
// grid, one pixel per point: that is the symbol at pointSize on the
// 1/scale point grid of a scale× display, where SwiftUI lays it out.
func drawSymbol(name string, pointSize float64, w symbolWeight, scale int) (SymbolImage, error) {
	if err := loadAppKit(); err != nil {
		return SymbolImage{}, err
	}
	var (
		m   symbolMetrics
		a   *image.Alpha
		err error
	)
	appKit.mu.Lock()
	withPool(func() {
		var img objc.ID
		if img, err = sfSymbol(name, pointSize*float64(scale), w); err != nil {
			return
		}
		m = measureSymbol(img)
		a, err = rasterSymbol(img, m.size)
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
