package main

import "testing"

func TestFirstRunVerdict(t *testing.T) {
	probe := func(home, welcome, phone bool, actions float64, errs ...any) map[string]any {
		return map[string]any{"hostHome": home, "settled": true, "welcome": welcome, "phone": phone, "actions": actions, "width": 360.0, "errors": errs}
	}
	unsettled := probe(true, false, true, 2)
	unsettled["settled"] = false
	cases := []struct {
		name     string
		probe    map[string]any
		reported int64
		phone    bool
		done, ok bool
	}{
		{"the host screen in the phone layout", probe(true, false, true, 2), 0, true, true, true},
		{"a startup failure the page caught and reported", probe(true, false, true, 2), 1, true, true, false},
		{"an uncaught error", probe(true, false, true, 2, "TypeError"), 0, false, true, false},
		{"the account welcome over the host screen: dismissed, look again", probe(true, true, true, 2), 0, true, false, false},
		{"the host screen with no host action a click reaches", probe(true, false, true, 0), 0, true, false, false},
		{"no host screen yet", probe(false, false, true, 2), 0, true, false, false},
		{"the host screen before the welcome is decided", unsettled, 0, true, false, false},
		{"the desktop layout when the phone was asked", probe(true, false, false, 2), 0, true, true, false},
		{"the desktop layout when it wasn't", probe(true, false, false, 2), 0, false, true, true},
	}
	for _, c := range cases {
		done, ok, why := firstRunVerdict(c.probe, c.reported, c.phone)
		if done != c.done || ok != c.ok {
			t.Errorf("%s: done=%v ok=%v (%s), want done=%v ok=%v", c.name, done, ok, why, c.done, c.ok)
		}
	}
}
