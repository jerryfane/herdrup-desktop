package design

import (
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
