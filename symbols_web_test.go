//go:build !darwin

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var updateWebSymbols = flag.Bool("update-websymbols", false, "rewrite testdata/websymbols.golden.json")

// webSymbolSizes are the point sizes and weights the screens draw symbols
// at (src/**/*.ts; test/websymbols.test.ts checks the list is complete).
var webSymbolSizes = []struct {
	size   float64
	weight string
}{
	{9, "bold"}, {10, "bold"}, {10, "heavy"}, {11, "bold"}, {11, "semibold"},
	{12, "medium"}, {12, "semibold"}, {13, "medium"}, {13, "semibold"},
	{14, "medium"}, {14, "semibold"}, {15, "medium"}, {15, "regular"},
	{15, "semibold"}, {16, "medium"}, {16, "semibold"}, {17, "semibold"},
	{18, "medium"}, {18, "regular"}, {18, "semibold"}, {19, "regular"},
	{19, "semibold"}, {21, "medium"}, {22, "regular"}, {28, "regular"},
}

// webSymbolErrors are calls Image refuses, with each check's error text.
var webSymbolErrors = []struct {
	name   string
	size   float64
	weight string
	scale  int
}{
	{"", 12, "regular", 2},
	{"square.grid.2x2", 12, "regular", 2},
	{"Chevron.Right", 12, "regular", 2},
	{"chevron.right ", 12, "regular", 2},
	{"../LICENSE", 12, "regular", 2},
	{"person.2", 19, "regular", 2},
	{"chevron.right", 12, "Bold", 2},
	{"chevron.right", 12, "", 2},
	{"chevron.right", 12, "semi\"bold\\\x00\x7f\u0085é\u00a0\u2028😀\a\v", 2},
	{"", 0, "bold", 0},
	{"chevron.right", 0, "bold", 2},
	{"chevron.right", -1, "bold", 2},
	{"chevron.right", 512.0001, "bold", 2},
	{"chevron.right", 600, "bold", 2},
	{"chevron.right", -1.5e-7, "bold", 2},
	{"chevron.right", 1e6, "bold", 2},
	{"chevron.right", 1.5e-7, "bold", 0},
	{"chevron.right", 12, "bold", 0},
	{"chevron.right", 12, "bold", 4},
	{"chevron.right", 12, "bold", -1},
}

// TestWebSymbolsGolden pins Symbols.Image for every stand-in at every size
// and weight the screens use, at each scale, and the errors of refused
// calls, so src/web/symbols.ts is held to the desktop's own drawing
// (test/websymbols.test.ts). An image row is name, size, weight, scale,
// width, height, baseline and the first 16 hex digits of the data URL's
// SHA-256.
func TestWebSymbolsGolden(t *testing.T) {
	var out bytes.Buffer
	row := func(v ...any) {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		out.WriteString(" ")
		out.Write(b)
	}
	out.WriteString("{\n\"images\": [\n")
	for i, s := range standIns {
		for j, z := range webSymbolSizes {
			for scale := 1; scale <= 3; scale++ {
				img, err := (Symbols{}).Image(s.symbol, z.size, z.weight, scale)
				if err != nil {
					t.Fatalf("%s at %v %s %dx: %v", s.symbol, z.size, z.weight, scale, err)
				}
				sum := sha256.Sum256([]byte(img.DataURL))
				row(s.symbol, z.size, z.weight, scale, img.Width, img.Height, img.Baseline, hex.EncodeToString(sum[:8]))
				if i < len(standIns)-1 || j < len(webSymbolSizes)-1 || scale < 3 {
					out.WriteString(",")
				}
				out.WriteString("\n")
			}
		}
	}
	out.WriteString("],\n\"errors\": [\n")
	for i, c := range webSymbolErrors {
		_, err := (Symbols{}).Image(c.name, c.size, c.weight, c.scale)
		if err == nil {
			t.Fatalf("Image(%q, %v, %q, %d) drew", c.name, c.size, c.weight, c.scale)
		}
		row(c.name, c.size, c.weight, c.scale, err.Error())
		if i < len(webSymbolErrors)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString("]\n}\n")

	golden := filepath.Join("testdata", "websymbols.golden.json")
	if *updateWebSymbols {
		if err := os.WriteFile(golden, out.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), want) {
		t.Fatalf("Symbols.Image differs from %s (go test -run TestWebSymbolsGolden -update-websymbols . to accept, then run test/websymbols.test.ts)", golden)
	}
}
