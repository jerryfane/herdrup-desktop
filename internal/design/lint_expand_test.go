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
// a side-only width. A different value beside it still is (note #48-f2), as
// is an alias, which may have been computed on an ancestor: the card below
// inherits --v as 3px while its own --w is 0 (review of #173).
func TestLintStylesHoldsAVariableToOneValuePerDeclaration(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	css := ".a { --w: 0; }\n.b { --w: 3px; }\n.c { border-width: var(--w) var(--w); }\n" +
		":root { --v: var(--w); }\n.e { border-width: var(--w) var(--v); }\n" +
		".f { border-width: 0 var(--w); }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	var flagged []string
	for _, e := range LintStyles(root) {
		flagged = append(flagged, e.Error())
	}
	got := strings.Join(flagged, "\n")
	if strings.Contains(got, "app.css:3") {
		t.Errorf("a uniform width through one variable was flagged:\n%s", got)
	}
	for _, line := range []string{"app.css:5", "app.css:6"} {
		if !strings.Contains(got, line) {
			t.Errorf("the side-only width on %s was not flagged:\n%s", line, got)
		}
	}
}

// Holding each repeated variable to one value expands the rest of the
// declaration once per value; many such variables must not multiply that
// work past the expansion budget (review of #173: 22 took over 5s).
func TestLintStylesManyRepeatedVariablesStayFast(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	var decl, refs strings.Builder
	for i := 0; i < 22; i++ {
		fmt.Fprintf(&decl, ".a%d { --v%c: 1px; }\n.b%d { --v%c: 2px; }\n", i, 'a'+i, i, 'a'+i)
		fmt.Fprintf(&refs, " var(--v%c) var(--v%c)", 'a'+i, 'a'+i)
	}
	css := decl.String() + ".grid { grid-template-columns:" + refs.String() + "; }\n"
	if err := os.WriteFile(filepath.Join(root, "src", "app.css"), []byte(css), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan []error, 1)
	go func() { done <- LintStyles(root) }()
	select {
	case errs := <-done:
		if len(errs) != 0 {
			t.Errorf("a grid of widths was flagged: %v", errs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("LintStyles took longer than 5s on 22 variables each referenced twice")
	}
}
