//go:build !linux

package main

import "github.com/egoist/mygo"

// WKWebView (macOS) and WebView2 (Windows) are left at their defaults.
func webkitFeaturesToEnable() []string { return nil }

func enableWebKitFeatures(*mygo.Window, []string) error { return nil }
