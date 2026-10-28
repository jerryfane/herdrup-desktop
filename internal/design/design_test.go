package design

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const fixture = `{
  "schema_version": 1,
  "_comment": "test",
  "color": {
    "dark": {"ground": "#13162A", "textFaint": "#666D91", "onAccentDimOpacity": 0.82},
    "light": null
  },
  "status": {"waiting": "#E9A63C"},
  "group": {"needsYou": "{status.waiting}", "idle": "{color.dark.textFaint}"},
  "agentGradient": {"claude": ["#CE58A4", "#A32E77"]},
  "chat": {"dark": {"codeText": "#A9B1D6"}, "light": {"codeText": "#6172B0"}},
  "font": {
    "machine": {
      "family": "IBM Plex Mono",
      "fallback": ["ui-monospace", "SF Mono", "monospace"],
      "faces": {"600": {"postscript": "IBMPlexMono-SmBld", "file": "App/Fonts/IBMPlexMono-SemiBold.ttf"}},
      "license": "App/Fonts/IBMPlexMono-OFL.txt"
    }
  },
  "type": {"microLabel": {"font": "machine", "size": 11, "weight": 600, "uppercase": true}}
}`

func TestParseRejectsBadTokens(t *testing.T) {
	for name, tc := range map[string]struct{ from, to, want string }{
		"dangling reference": {`"{status.waiting}"`, `"{status.gone}"`, "dangling reference {status.gone}"},
		"reference to group": {`"{status.waiting}"`, `"{status}"`, "not a single token"},
		"reference to null":  {`"{status.waiting}"`, `"{color.light}"`, "not a single token"},
		"cycle":              {`"waiting": "#E9A63C"`, `"waiting": "{group.needsYou}"`, "cycle"},
		"unknown group":      {`"_comment": "test"`, `"spacing": {}`, `unknown group "spacing"`},
		"newer schema":       {`"schema_version": 1`, `"schema_version": 2`, "schema_version 2"},
	} {
		t.Run(name, func(t *testing.T) {
			src := strings.Replace(fixture, tc.from, tc.to, 1)
			if src == fixture {
				t.Fatal("fixture edit did not apply")
			}
			_, err := Parse([]byte(src))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error containing %q", err, tc.want)
			}
		})
	}
}

func TestCSS(t *testing.T) {
	tok, err := Parse([]byte(fixture))
	if err != nil {
		t.Fatal(err)
	}
	css, err := tok.CSS("")
	if err != nil {
		t.Fatal(err)
	}
	got := string(css)
	for _, want := range []string{
		"@font-face {\n  font-family: \"IBM Plex Mono\";\n  src: url(\"/fonts/IBMPlexMono-SemiBold.ttf\") format(\"truetype\");\n  font-weight: 600;",
		"  --color-ground: #13162a;\n",
		"  --color-on-accent-dim-opacity: 0.82;\n",
		"  --status-waiting: #e9a63c;\n",
		"  --group-needs-you: var(--status-waiting);\n",
		"  --group-idle: var(--color-text-faint);\n",
		"  --chat-code-text: #a9b1d6;\n",
		"  --agent-gradient-claude: linear-gradient(135deg, #ce58a4, #a32e77);\n",
		"  --font-machine: \"IBM Plex Mono\", ui-monospace, \"SF Mono\", monospace;\n",
		"  --type-micro-label-font: var(--font-machine);\n  --type-micro-label-size: 11px;\n  --type-micro-label-weight: 600;\n  --type-micro-label-transform: uppercase;\n",
		":root[data-theme=\"light\"] {\n  --chat-code-text: #6172b0;\n}\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("CSS lacks %q\n--- CSS ---\n%s", want, got)
		}
	}
	if strings.Contains(got, "--color-light") || strings.Contains(got, "dark") {
		t.Errorf("theme segment leaked into a variable name:\n%s", got)
	}
}

func TestTypeRoleMustUseAnExistingFace(t *testing.T) {
	tok, err := Parse([]byte(strings.Replace(fixture, `"weight": 600`, `"weight": 700`, 1)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tok.CSS(""); err == nil || !strings.Contains(err.Error(), "no 700 face") {
		t.Fatalf("got %v, want a missing-face error", err)
	}
}

// fakeHerdrup serves files of one commit.
func fakeHerdrup(commit string, files map[string]string) Fetcher {
	return func(_ context.Context, c, source string) ([]byte, error) {
		if c != commit {
			return nil, fmt.Errorf("unknown commit %s", c)
		}
		data, ok := files[source]
		if !ok {
			return nil, fmt.Errorf("404 %s", source)
		}
		return []byte(data), nil
	}
}

const pin = "0123456789abcdef0123456789abcdef01234567"

func synced(t *testing.T) (string, Fetcher) {
	t.Helper()
	root := t.TempDir()
	fetch := fakeHerdrup(pin, map[string]string{
		TokensSource:                         fixture,
		"App/Fonts/IBMPlexMono-SemiBold.ttf": "font bytes",
		"App/Fonts/IBMPlexMono-OFL.txt":      "licence",
	})
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "style.css"), []byte("body { color: var(--color-ground); }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Sync(context.Background(), root, pin, fetch); err != nil {
		t.Fatal(err)
	}
	return root, fetch
}

func TestSyncWritesPinnedCopiesAndPassesCheck(t *testing.T) {
	root, fetch := synced(t)
	for _, rel := range []string{TokensCopy, "public/fonts/IBMPlexMono-SemiBold.ttf", "public/fonts/IBMPlexMono-OFL.txt", CSSPath, GoPath} {
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Errorf("missing %s", rel)
		}
	}
	prov, err := ReadProvenance(root)
	if err != nil || prov.Commit != pin || len(prov.Files) != 3 {
		t.Fatalf("provenance %+v, %v", prov, err)
	}
	if errs := Check(root); len(errs) != 0 {
		t.Fatalf("check after a clean sync: %v", errs)
	}
	if errs := VerifyUpstream(context.Background(), root, fetch); len(errs) != 0 {
		t.Fatalf("upstream check after a clean sync: %v", errs)
	}
	goSrc, _ := os.ReadFile(filepath.Join(root, GoPath))
	if !regexp.MustCompile(`\bColorGround\s+= "#13162A"`).Match(goSrc) {
		t.Fatalf("Go constants:\n%s", goSrc)
	}
}

func TestSyncRefusesAShortCommit(t *testing.T) {
	if err := Sync(context.Background(), t.TempDir(), "main", nil); err == nil {
		t.Fatal("pinned a branch name")
	}
}

func edit(t *testing.T, root, rel, from, to string) {
	t.Helper()
	p := filepath.Join(root, rel)
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	out := strings.Replace(string(data), from, to, 1)
	if from != "" && out == string(data) {
		t.Fatalf("edit of %s did not apply", rel)
	}
	if from == "" {
		out = string(data) + to
	}
	if err := os.WriteFile(p, []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckFindsDrift(t *testing.T) {
	for name, tc := range map[string]struct {
		rel, from, to, want string
	}{
		"hand-edited generated CSS":      {CSSPath, "#13162a", "#000000", "src/tokens.css is stale or edited"},
		"edited synced tokens":           {TokensCopy, "#E9A63C", "#FF0000", "differs from jerryfane/herdrup design/tokens.json"},
		"edited font":                    {"public/fonts/IBMPlexMono-SemiBold.ttf", "font", "FONT", "differs from jerryfane/herdrup App/Fonts/IBMPlexMono-SemiBold.ttf"},
		"colour literal in a stylesheet": {"src/style.css", "", ".x { color: #fff; }\n", `src/style.css:2: colour literal "#fff"`},
		"rgb() in a stylesheet":          {"src/style.css", "", ".x { background: rgba(0, 0, 0, 0.5); }\n", "colour literal"},
		"side stripe":                    {"src/style.css", "", ".card { border-left: 3px solid var(--status-waiting); }\n", "side stripe"},
		"inset stripe":                   {"src/style.css", "", ".card { box-shadow: inset 4px 0 0 var(--status-waiting); }\n", "side stripe"},
	} {
		t.Run(name, func(t *testing.T) {
			root, _ := synced(t)
			edit(t, root, tc.rel, tc.from, tc.to)
			errs := Check(root)
			if !strings.Contains(fmt.Sprint(errs), tc.want) {
				t.Fatalf("got %v, want an error containing %q", errs, tc.want)
			}
		})
	}
}

func TestCheckAllowsColoursInComments(t *testing.T) {
	root, _ := synced(t)
	edit(t, root, "src/style.css", "", "/* was #13162a\n   before tokens */\n.y { border: 1px solid var(--color-ground); }\n")
	if errs := Check(root); len(errs) != 0 {
		t.Fatalf("got %v", errs)
	}
}

func TestVerifyUpstreamCatchesARewrittenRecord(t *testing.T) {
	root, fetch := synced(t)
	// Edit the copy and rewrite its recorded hash so the offline check passes.
	edit(t, root, TokensCopy, "#E9A63C", "#FF0000")
	data, _ := os.ReadFile(filepath.Join(root, TokensCopy))
	prov, _ := ReadProvenance(root)
	edit(t, root, ProvenancePath, prov.Files[0].SHA256, sum(data))
	if err := Generate(root); err != nil {
		t.Fatal(err)
	}
	if errs := Check(root); len(errs) != 0 {
		t.Fatalf("offline check should pass a consistent rewrite: %v", errs)
	}
	errs := VerifyUpstream(context.Background(), root, fetch)
	if !strings.Contains(fmt.Sprint(errs), "design/tokens.json at 0123456789ab has sha256") {
		t.Fatalf("got %v", errs)
	}
}

func TestResyncRemovesFontsTheNewPinDropped(t *testing.T) {
	root, _ := synced(t)
	stale := filepath.Join(root, "public/fonts/Old.ttf")
	if err := os.WriteFile(stale, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	fetch := fakeHerdrup(pin, map[string]string{
		TokensSource:                         fixture,
		"App/Fonts/IBMPlexMono-SemiBold.ttf": "font bytes",
		"App/Fonts/IBMPlexMono-OFL.txt":      "licence",
	})
	if err := Sync(context.Background(), root, pin, fetch); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("a font the pin no longer lists was kept")
	}
}
