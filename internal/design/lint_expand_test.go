package design

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A variable declared with two values in separate rules, used many times
// in one declaration, must lint quickly: the variants are capped, and so
// must the work to find them be (#53). Before the fix 28 references took
// longer than three seconds; this uses 40.
func TestLintStylesManyReferencesToAVariableWithSeveralValues(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	css := ".a { --gap: 1px; }\n.b { --gap: 2px; }\n.grid { grid-template-columns:" +
		strings.Repeat(" var(--gap)", 40) + "; }\n.s { box-shadow: inset var(--gap) 0 currentColor; }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan []error, 1)
	go func() { done <- LintStyles(root) }()
	select {
	case errs := <-done:
		// A stripe drawn with the same variable is still flagged.
		found := false
		for _, e := range errs {
			if strings.Contains(e.Error(), "app.css:4") {
				found = true
			}
		}
		if !found {
			t.Errorf("the inset stripe on line 4 was not flagged: %v", errs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LintStyles took longer than 5s on 40 references to a two-valued variable")
	}
}

// One element computes one value for a variable, so two references to it
// in a declaration agree: `var(--w) var(--w)` is uniformly 0 or 3px, never
// a side-only width, also when one is a fallback written here (review of
// #176). A different value beside it still is (note #48-f2), as is an
// alias, which may have been computed on an ancestor: the card below
// inherits --v as 3px while its own --w is 0 (review of #173).
func TestLintStylesHoldsAVariableToOneValuePerDeclaration(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	css := ".a { --w: 0; }\n.b { --w: 3px; }\n.c { border-width: var(--w) var(--w); }\n" +
		":root { --v: var(--w); }\n.e { border-width: var(--w) var(--v); }\n" +
		".f { border-width: 0 var(--w); }\n" +
		".g { border-width: var(--w) var(--undefined, var(--w)); }\n" +
		".h { border-width: var(--unset, var(--w)) var(--w); }\n" +
		".parent { --pair: var(--w) var(--w); }\n.i { border-width: var(--pair); }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	var flagged []string
	for _, e := range LintStyles(root) {
		flagged = append(flagged, e.Error())
	}
	got := strings.Join(flagged, "\n")
	for _, line := range []string{"app.css:3", "app.css:7", "app.css:8", "app.css:10"} {
		if strings.Contains(got, line) {
			t.Errorf("a uniform width through one variable was flagged at %s:\n%s", line, got)
		}
	}
	for _, line := range []string{"app.css:5", "app.css:6"} {
		if !strings.Contains(got, line) {
			t.Errorf("the side-only width on %s was not flagged:\n%s", line, got)
		}
	}
}

// Variants that come out the same count once, and a variant bound that cuts
// combinations short leaves the check incomplete: here 256 values of --w in
// an unused fallback all read the same before --a's stripe value is tried
// (review of #179).
func TestLintStylesReachesAStripePastRepeatedSameVariants(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	css := ".a1 { --a: 0 0; }\n.a2 { --a: inset 3px 0; }\n"
	for i := 0; i < 256; i++ {
		css += fmt.Sprintf(".w%d { --w: 0; }\n", i)
	}
	css += ".card { box-shadow: var(--a), var(--a, var(--w) var(--w)); }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	errs := LintStyles(root)
	if len(errs) != 1 || !strings.Contains(errs[0].Error(), "app.css:259") || !strings.Contains(errs[0].Error(), "side stripe") {
		t.Errorf("want the inset stripe on line 259, got %v", errs)
	}
}

// Holding each repeated variable to one value expands the declaration once
// per combination; many such variables must stop at the work bound, quickly,
// and say the check is incomplete rather than pass (reviews of #173, #176).
func TestLintStylesManyRepeatedVariablesStopAndSaySo(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	var decl, layers []string
	for i := 0; i < 22; i++ {
		decl = append(decl, fmt.Sprintf(".a%d { --v%c: 1px; }\n.b%d { --v%c: 2px; }\n", i, 'a'+i, i, 'a'+i))
		layers = append(layers, fmt.Sprintf("0 0 var(--v%c) var(--v%c) currentColor", 'a'+i, 'a'+i))
	}
	css := strings.Join(decl, "") + ".glow { box-shadow: " + strings.Join(layers, ", ") + "; }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan []error, 1)
	go func() { done <- LintStyles(root) }()
	select {
	case errs := <-done:
		if len(errs) != 1 || !strings.Contains(errs[0].Error(), "too many var() combinations") {
			t.Errorf("want one incomplete-check error, got %v", errs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LintStyles took longer than 5s on 22 variables each referenced twice")
	}
}

// A stripe written out literally is flagged even when the variables beside
// it are too costly to expand (review of #176).
func TestLintStylesFlagsALiteralStripeBesideCostlyVariables(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	css := ":root { --a: 1px; }\n"
	for _, p := range [][2]string{{"b", "a"}, {"c", "b"}, {"d", "c"}, {"e", "d"}} {
		css += ":root { --" + p[0] + ": calc(" + strings.TrimSuffix(strings.Repeat("var(--"+p[1]+") + ", 10), " + ") + "); }\n"
	}
	css += ".card { box-shadow: inset 3px 0 currentColor, 0 0 var(--e) currentColor; }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	errs := LintStyles(root)
	if len(errs) != 1 || !strings.Contains(errs[0].Error(), "app.css:6") || !strings.Contains(errs[0].Error(), "side stripe") {
		t.Errorf("want the literal inset stripe on line 6, got %v", errs)
	}
}
