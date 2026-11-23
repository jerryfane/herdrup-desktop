package main

import "testing"

func TestFirstRunVerdict(t *testing.T) {
	works := map[string]any{"hostHome": true, "controls": 3.0, "width": 360.0, "errors": []any{}}
	cases := []struct {
		name     string
		probe    map[string]any
		reported int64
		phone    bool
		done, ok bool
	}{
		{"the host screen at phone width", works, 0, true, true, true},
		{"a startup failure the page caught and reported", works, 1, true, true, false},
		{"an uncaught error", map[string]any{"hostHome": true, "controls": 3.0, "width": 360.0, "errors": []any{"TypeError"}}, 0, false, true, false},
		{"the host screen without a visible control", map[string]any{"hostHome": true, "controls": 0.0, "width": 360.0}, 0, true, false, false},
		{"no host screen yet", map[string]any{"hostHome": false, "controls": 3.0, "width": 360.0}, 0, true, false, false},
		{"the desktop width when the phone was asked", map[string]any{"hostHome": true, "controls": 3.0, "width": 1280.0}, 0, true, true, false},
		{"the desktop width when it wasn't", map[string]any{"hostHome": true, "controls": 3.0, "width": 1280.0}, 0, false, true, true},
	}
	for _, c := range cases {
		done, ok, why := firstRunVerdict(c.probe, c.reported, c.phone)
		if done != c.done || ok != c.ok {
			t.Errorf("%s: done=%v ok=%v (%s), want done=%v ok=%v", c.name, done, ok, why, c.done, c.ok)
		}
	}
}
