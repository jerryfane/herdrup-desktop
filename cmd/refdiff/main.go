// Command refdiff compares a capture of the desktop window with one of
// herdrup's reference screenshots, pixel by pixel, and draws where they
// differ. The parity workflow (.github/workflows/parity.yml) runs it.
//
// It exits 0 when the capture is within the thresholds, 1 when it is not
// (or the sizes differ), and 2 when the pictures cannot be compared.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"strings"
)

// Report is what -report writes: the result, the thresholds and verdict.
type Report struct {
	Ref       string  `json:"ref"`
	Got       string  `json:"got"`
	Diff      string  `json:"diff,omitempty"`
	RefColor  string  `json:"refColor"`
	GotColor  string  `json:"gotColor"`
	Tol       int     `json:"tol"`
	MaxOver   float64 `json:"maxOverPct"`
	MaxDelta  int     `json:"maxDeltaLimit"`
	MaskRects int     `json:"maskRects"`
	Result
	Pass     bool     `json:"pass"`
	Failures []string `json:"failures,omitempty"`
	Error    string   `json:"error,omitempty"`
}

func main() {
	refPath := flag.String("ref", "", "reference PNG")
	gotPath := flag.String("got", "", "captured PNG")
	cropTop := flag.Float64("crop-top-pt", 0, "points cut from the top of the reference (its status bar)")
	scale := flag.Int("scale", 2, "the reference's pixels per point")
	maskPath := flag.String("mask", "", "JSON mask file: rects in reference points not to compare")
	out := flag.String("out", "", "write the diff picture here (PNG)")
	reportPath := flag.String("report", "", "write the result here (JSON)")
	tol := flag.Int("tol", 2, "largest channel difference (0-255) that still counts as equal")
	maxOver := flag.Float64("max-over-pct", 0, "fail when more than this percentage of the compared pixels differ by more than -tol")
	maxDelta := flag.Int("max-delta", 255, "fail when any compared pixel's channel differs by more than this")
	flag.Parse()
	if *refPath == "" || *gotPath == "" {
		flag.Usage()
		os.Exit(2)
	}

	rep := Report{Ref: *refPath, Got: *gotPath, Diff: *out, Tol: *tol, MaxOver: *maxOver, MaxDelta: *maxDelta}
	fail := func(err error) {
		rep.Error = err.Error()
		writeReport(*reportPath, rep)
		fmt.Fprintln(os.Stderr, "refdiff:", err)
		os.Exit(2)
	}
	var mask Mask
	if *maskPath != "" {
		data, err := os.ReadFile(*maskPath)
		if err != nil {
			fail(err)
		}
		if err := json.Unmarshal(data, &mask); err != nil {
			fail(fmt.Errorf("%s: %w", *maskPath, err))
		}
	}
	rep.MaskRects = len(mask.Rects)
	ref, refColor, err := load(*refPath)
	if err != nil {
		fail(err)
	}
	got, gotColor, err := load(*gotPath)
	if err != nil {
		fail(err)
	}
	rep.RefColor, rep.GotColor = refColor, gotColor
	res, diff, err := Compare(ref, got, Options{RefScale: *scale, CropTopPt: *cropTop, Tol: *tol, Mask: mask.Rects})
	rep.Result = res
	if err != nil {
		fail(err)
	}
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fail(err)
		}
		if err := png.Encode(f, diff); err != nil {
			fail(err)
		}
		if err := f.Close(); err != nil {
			fail(err)
		}
	}
	if res.SizeMismatch {
		rep.Failures = append(rep.Failures, fmt.Sprintf("size: capture %dx%d px, want %dx%d px (the reference below its status bar at the capture's scale)",
			res.GotPx[0], res.GotPx[1], res.WantPx[0], res.WantPx[1]))
	}
	if res.OverPct > *maxOver {
		rep.Failures = append(rep.Failures, fmt.Sprintf("%.3f%% of pixels differ by more than %d (limit %g%%)", res.OverPct, *tol, *maxOver))
	}
	if res.MaxDelta > *maxDelta {
		rep.Failures = append(rep.Failures, fmt.Sprintf("max channel delta %d (limit %d)", res.MaxDelta, *maxDelta))
	}
	rep.Pass = len(rep.Failures) == 0
	writeReport(*reportPath, rep)

	verdict := "PASS"
	if !rep.Pass {
		verdict = "FAIL: " + strings.Join(rep.Failures, "; ")
	}
	fmt.Printf("refdiff: %s vs %s: capture %dx%d px (scale %d), reference %dx%d px (scale %d), compared at %dx; "+
		"%.3f%% over tol %d (%d of %d px), max delta %d, mean %.2f, masked %d px; colour got %s, ref %s; %s\n",
		*gotPath, *refPath, res.GotPx[0], res.GotPx[1], res.GotScale, res.RefPx[0], res.RefPx[1], *scale, res.Scale,
		res.OverPct, *tol, res.Over, res.Compared, res.MaxDelta, res.MeanDelta, res.Masked, gotColor, refColor, verdict)
	if !rep.Pass {
		os.Exit(1)
	}
}

func load(path string) (image.Image, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", fmt.Errorf("%s: %w", path, err)
	}
	return img, pngColor(data), nil
}

func writeReport(path string, rep Report) {
	if path == "" {
		return
	}
	data, _ := json.MarshalIndent(rep, "", "  ")
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "refdiff:", err)
		os.Exit(2)
	}
}
