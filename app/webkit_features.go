package main

// WebKit features the app turns on early, where the installed engine already
// ships them as stable. SubpixelInlineLayout places text at fractional
// positions like Core Text does for the Swift app; herdr-app 380093 allows it
// only once WebKitGTK labels it stable, so engines that still call it
// unstable (2.52 does) keep their integral layout.
var earlyWebKitFeatures = []string{"SubpixelInlineLayout"}

// webkitFeatureStatusStable is WEBKIT_FEATURE_STATUS_STABLE; MATURE (7) is
// above it.
const webkitFeatureStatusStable = 6

type webkitFeature struct {
	ID     string
	Status int32
}

// stableWebKitFeatures returns the wanted features that installed reports at
// least stable, and one reason per wanted feature it leaves off.
func stableWebKitFeatures(installed []webkitFeature, wanted []string) (enable, skipped []string) {
	status := make(map[string]int32, len(installed))
	for _, f := range installed {
		status[f.ID] = f.Status
	}
	for _, id := range wanted {
		s, ok := status[id]
		switch {
		case !ok:
			skipped = append(skipped, id+" not in this WebKit")
		case s < webkitFeatureStatusStable:
			skipped = append(skipped, id+" not stable in this WebKit")
		default:
			enable = append(enable, id)
		}
	}
	return enable, skipped
}
