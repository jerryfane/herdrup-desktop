package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStartupReport(t *testing.T) {
	if got := startupReport(30*time.Second, `{"step":"rendered","ticks":2,"visibility":"visible"}`, nil); got != "" {
		t.Errorf("a rendered page: %q, want nothing", got)
	}
	stuck := startupReport(30*time.Second, `{"step":"fonts","ticks":0,"visibility":"hidden"}`, nil)
	for _, want := range []string{"30s", `"step":"fonts"`, `"ticks":0`, `"visibility":"hidden"`} {
		if !strings.Contains(stuck, want) {
			t.Errorf("a stuck page: %q lacks %s", stuck, want)
		}
	}
	if got := startupReport(time.Minute, nil, errors.New("context deadline exceeded")); !strings.Contains(got, "didn't answer") || !strings.Contains(got, "deadline") {
		t.Errorf("a page that doesn't answer: %q", got)
	}
	if got := startupReport(time.Minute, `{"step":"fonts","fallback":"host screen"}`, nil); got == "" {
		t.Error("a fallback render is still reported")
	}
}
