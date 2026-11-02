package main

import (
	"reflect"
	"testing"
)

func TestWebKitFeatureTurnsOnOnceStable(t *testing.T) {
	for _, status := range []int32{webkitFeatureStatusStable, webkitFeatureStatusStable + 1} {
		enable, skipped := stableWebKitFeatures([]webkitFeature{{"Other", 1}, {"SubpixelInlineLayout", status}}, earlyWebKitFeatures)
		if !reflect.DeepEqual(enable, []string{"SubpixelInlineLayout"}) || skipped != nil {
			t.Fatalf("status %d: enable %v, skipped %v; want SubpixelInlineLayout on", status, enable, skipped)
		}
	}
}

func TestWebKitFeatureStaysOffUnlessStable(t *testing.T) {
	cases := map[string][]webkitFeature{
		// WebKitGTK 2.52.6: WEBKIT_FEATURE_STATUS_UNSTABLE.
		"unstable": {{"SubpixelInlineLayout", 1}},
		"preview":  {{"SubpixelInlineLayout", webkitFeatureStatusStable - 1}},
		"absent":   {{"TextShapingAcrossInlineBoxes", webkitFeatureStatusStable}},
		"no list":  nil,
	}
	for name, installed := range cases {
		enable, skipped := stableWebKitFeatures(installed, earlyWebKitFeatures)
		if enable != nil || len(skipped) != 1 {
			t.Errorf("%s: enable %v, skipped %v; want it left off with one reason", name, enable, skipped)
		}
	}
}
