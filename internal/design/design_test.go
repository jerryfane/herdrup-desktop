package design

import (
	"context"
	"encoding/json"
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
    },
    "system": {"_comment": "platform font", "family": "system", "fallback": ["-apple-system", "Segoe UI", "sans-serif"]}
  },
  "space": {"rowLead": 20, "avatarGap": "{space.rowLead}"},
  "radius": {"card": 14},
  "size": {"agentRow": 80, "badgeStroke": 2.5},
  "text": {
    "rowName": {"font": "system", "size": 16, "weight": 600},
    "rowAge": {"font": "system", "size": 14, "weight": 400, "tabular": true},
    "microLabel": {"font": "machine", "size": 11, "weight": 600, "uppercase": true, "tracking": 1.2}
  },
  "type": {"microLabel": {"font": "{text.microLabel.font}", "size": "{text.microLabel.size}", "weight": "{text.microLabel.weight}", "uppercase": "{text.microLabel.uppercase}"}}
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
		"  --group-idle: #666d91;\n",
		"  --chat-code-text: #a9b1d6;\n",
		"  --agent-gradient-claude: linear-gradient(135deg, #ce58a4, #a32e77);\n",
		"  --font-machine: \"IBM Plex Mono\", ui-monospace, \"SF Mono\", monospace;\n",
		"  --type-micro-label-font: var(--font-machine);\n  --type-micro-label-size: 11px;\n  --type-micro-label-weight: 600;\n  --type-micro-label-transform: uppercase;\n",
		"  --space-avatar-gap: 20px;\n  --space-row-lead: 20px;\n",
		"  --radius-card: 14px;\n",
		"  --size-agent-row: 80px;\n  --size-badge-stroke: 2.5px;\n",
		"  --font-system: -apple-system, \"Segoe UI\", sans-serif;\n",
		"  --text-micro-label-font: var(--font-machine);\n  --text-micro-label-size: 11px;\n  --text-micro-label-weight: 600;\n  --text-micro-label-transform: uppercase;\n  --text-micro-label-tracking: 1.2px;\n  --text-micro-label-numeric: normal;\n",
		"  --text-row-age-font: var(--font-system);\n  --text-row-age-size: 14px;\n  --text-row-age-weight: 400;\n  --text-row-age-transform: none;\n  --text-row-age-tracking: normal;\n  --text-row-age-numeric: tabular-nums;\n",
		"  --text-row-name-font: var(--font-system);\n  --text-row-name-size: 16px;\n  --text-row-name-weight: 600;\n",
		":root[data-theme=\"light\"] {\n  --chat-code-text: #6172b0;\n}\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("CSS lacks %q\n--- CSS ---\n%s", want, got)
		}
	}
	if strings.Contains(got, "--color-light") || strings.Contains(got, "dark") {
		t.Errorf("theme segment leaked into a variable name:\n%s", got)
	}
	if strings.Contains(got, `"system"`) || strings.Count(got, "@font-face") != 1 {
		t.Errorf("the system font must not be bundled or named:\n%s", got)
	}
}

func TestParseRejectsBadLayoutTokens(t *testing.T) {
	for name, tc := range map[string]struct{ from, to, want string }{
		"space as a string":      {`"radius": {"card": 14}`, `"radius": {"card": "14px"}`, "radius.card: want a number"},
		"tracking as a string":   {`"tracking": 1.2`, `"tracking": "wide"`, "tracking: want a number"},
		"tabular not a boolean":  {`"tabular": true`, `"tabular": 1`, "tabular: want true or false"},
		"text role, no font":     {`"rowName": {"font": "system"`, `"rowName": {"font": "serif"`, `font "serif" is not a key`},
		"bundled font, no faces": {`"family": "system"`, `"family": "Inter"`, "needs faces"},
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

func TestParseRejectsBadTypeRolesAndFiles(t *testing.T) {
	for name, tc := range map[string]struct{ from, to, want string }{
		"type role on a missing face":  {`"uppercase": true, "tracking": 1.2`, `"uppercase": true, "tracking": 1.2, "weight": 700`, "no 700 face"},
		"type role without a weight":   {`"size": 16, "weight": 600`, `"size": 16`, "needs a numeric size and weight"},
		"empty key":                    {`"ground": "#13162A"`, `"": "#13162A"`, `key ""`},
		"reference to a _ key":         {`"{status.waiting}"`, `"{_comment}"`, "not a token"},
		"backslash path":               {`App/Fonts/IBMPlexMono-OFL.txt`, `App\\Fonts\\..\\..\\main.go`, "not a clean relative path"},
		"dot-dot path":                 {`App/Fonts/IBMPlexMono-OFL.txt`, `App/../../evil.ttf`, "not a clean relative path"},
		"two files with the same name": {`App/Fonts/IBMPlexMono-OFL.txt`, `Other/IBMPlexMono-SemiBold.ttf`, "share the name"},
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

func TestReferenceIntoAThemeKeepsItsTheme(t *testing.T) {
	src := strings.Replace(fixture, `"light": null`, `"light": {"textFaint": "#AAAAAA"}`, 1)
	tok, err := Parse([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	css, err := tok.CSS("")
	if err != nil {
		t.Fatal(err)
	}
	// group.idle is {color.dark.textFaint}: the dark value, in both themes.
	if !strings.Contains(string(css), "--group-idle: #666d91;") {
		t.Fatalf("CSS:\n%s", css)
	}
	if !strings.Contains(string(css), ":root[data-theme=\"light\"] {\n  --color-text-faint: #aaaaaa;") {
		t.Fatalf("light override missing:\n%s", css)
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

// herdrupFiles is a fake herdrup at pin: the fixture tokens, the font files
// they name, and every shared asset.
func herdrupFiles() map[string]string {
	files := map[string]string{
		TokensSource:                         fixture,
		"App/Fonts/IBMPlexMono-SemiBold.ttf": "font bytes",
		"App/Fonts/IBMPlexMono-OFL.txt":      "licence",
	}
	for _, a := range Assets {
		files[a.Source] = "asset " + a.Source
	}
	return files
}

func synced(t *testing.T) (string, Fetcher) {
	t.Helper()
	root := t.TempDir()
	fetch := fakeHerdrup(pin, herdrupFiles())
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
	want := []string{TokensCopy, "public/fonts/IBMPlexMono-SemiBold.ttf", "public/fonts/IBMPlexMono-OFL.txt", CSSPath, GoPath}
	for _, a := range Assets {
		want = append(want, a.Dest)
	}
	for _, rel := range want {
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Errorf("missing %s", rel)
		}
	}
	prov, err := ReadProvenance(root)
	if err != nil || prov.Commit != pin || len(prov.Files) != 3+len(Assets) {
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
	if err != nil && !(from == "" && os.IsNotExist(err)) {
		t.Fatal(err)
	}
	out := strings.Replace(string(data), from, to, 1)
	if from != "" && out == string(data) {
		t.Fatalf("edit of %s did not apply", rel)
	}
	if from == "" {
		out = string(data) + to
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(out), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckFindsDrift(t *testing.T) {
	for name, tc := range map[string]struct {
		rel, from, to, want string
	}{
		"hand-edited generated CSS":       {CSSPath, "#13162a", "#000000", "src/tokens.css is stale or edited"},
		"edited synced tokens":            {TokensCopy, "#E9A63C", "#FF0000", "differs from jerryfane/herdrup design/tokens.json"},
		"edited font":                     {"public/fonts/IBMPlexMono-SemiBold.ttf", "font", "FONT", "differs from jerryfane/herdrup App/Fonts/IBMPlexMono-SemiBold.ttf"},
		"colour literal in a stylesheet":  {"src/style.css", "", ".x { color: #fff; }\n", `src/style.css:2: colour literal "#fff"`},
		"rgb() in a stylesheet":           {"src/style.css", "", ".x { background: rgba(0, 0, 0, 0.5); }\n", "colour literal"},
		"side stripe":                     {"src/style.css", "", ".card { border-left: 3px solid var(--status-waiting); }\n", "side stripe"},
		"inset stripe":                    {"src/style.css", "", ".card { box-shadow: inset 4px 0 0 var(--status-waiting); }\n", "side stripe"},
		"inset stripe, fractional em":     {"src/style.css", "", ".card { box-shadow: inset .5em 0px 0 var(--status-waiting); }\n", "side stripe"},
		"named colour":                    {"src/style.css", "", ".x { color: white; }\n", `colour literal "white"`},
		"named colour, upper case":        {"src/style.css", "", ".x {\n  border: 1px solid Red !important;\n}\n", `src/style.css:3: colour literal "Red"`},
		"colour in a custom property":     {"src/style.css", "", ".x { --accent: #ce58a4; color: var(--accent); }\n", `colour literal "#ce58a4"`},
		"named colour in a custom prop":   {"src/style.css", "", ".x { --accent: red; }\n", `colour literal "red"`},
		"inset after the offsets":         {"src/style.css", "", ".card { box-shadow: 4px 0 0 var(--status-waiting) inset; }\n", "side stripe"},
		"inset in a later layer":          {"src/style.css", "", ".card { box-shadow: 0 1px 2px var(--color-ground), inset -3px 0 var(--status-waiting); }\n", "side stripe"},
		"one-sided border-width":          {"src/style.css", "", ".card { border: solid var(--status-waiting); border-width: 0 0 0 3px; }\n", "side stripe"},
		"stripe with a colour-mix":        {"src/style.css", "", ".card { box-shadow: inset 3px 0 color-mix(in srgb, var(--status-waiting) 60%, transparent); }\n", "side stripe"},
		"stripe, colour function first":   {"src/style.css", "", ".card { box-shadow: inset rgb(from var(--status-waiting) r g b / 50%) 3px 0; }\n", "side stripe"},
		"stripe behind a custom property": {"src/style.css", "", ".c { --sh: inset 3px 0 var(--status-waiting); box-shadow: var(--sh); }\n", "side stripe"},
		"stripe declared in another rule": {"src/style.css", "", ".c { box-shadow: var(--edge); }\n:root { --edge: var(--edge-x) 0 0 inset; --edge-x: 4px; }\n", "side stripe"},
		"widths behind a custom property": {"src/style.css", "", ".c { --w: 0 0 0 3px; border: solid var(--status-waiting); border-width: var(--w); }\n", "side stripe"},
		"keyword width":                   {"src/style.css", "", ".c { border-width: 0 0 0 thick; }\n", "side stripe"},
		"signed and exponent offsets":     {"src/style.css", "", ".c { box-shadow: +3px +0 var(--status-waiting) inset, 3e0px 0 inset; }\n", "side stripe"},
		"stripe hidden by a later --s":    {"src/style.css", "", ".x { --s: inset 3px 0 var(--status-waiting); }\n.y { --s: none; }\n.c { box-shadow: var(--s); }\n", "side stripe"},
		"2-value side-only widths":        {"src/style.css", "", ".c { border-width: 0 3px; }\n", "side stripe"},
		"3-value side-only widths":        {"src/style.css", "", ".c { border-width: 0 3px 0; }\n", "side stripe"},
		"var() with a fallback in widths": {"src/style.css", "", ".c { border-width: 0 0 0 var(--bw, 3px); }\n", "side stripe"},
		"spaced calc() in widths":         {"src/style.css", "", ".c { border-width: 0 0 0 calc( 3px ); }\n", "side stripe"},
		"spaced calc() in a shadow":       {"src/style.css", "", ".c { box-shadow: inset calc( 3px ) 0; }\n", "side stripe"},
		"stripe in a var() fallback":      {"src/style.css", "", ".c { box-shadow: var(--none, inset 3px 0); }\n", "side stripe"},
		"stray file next to the fonts":    {"public/fonts/extra.ttf", "", "x", "public/fonts/extra.ttf is not from herdrup"},
		"stray script next to mermaid":    {"public/mermaid/evil.js", "", "x", "public/mermaid/evil.js is not from herdrup"},
		"stray file deep in herdrup dir":  {"public/herdrup/nested/deep.svg", "", "x", "public/herdrup/nested/deep.svg is not from herdrup"},
		"stray file at the top of public": {"public/evil.js", "", "x", "public/evil.js is not from herdrup"},
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

func TestCheckReportsAnUnreadableFolder(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any folder; permissions cannot make one unreadable")
	}
	root, _ := synced(t)
	hidden := filepath.Join(root, "public", "hidden")
	if err := os.MkdirAll(hidden, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hidden, "evil.js"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(hidden, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(hidden, 0o755) })
	if errs := Check(root); !strings.Contains(fmt.Sprint(errs), "cannot inspect") {
		t.Fatalf("got %v", errs)
	}
}

func TestCheckAllowsTokenDerivedAndNonColourValues(t *testing.T) {
	root, _ := synced(t)
	edit(t, root, "src/style.css", "", `/* was #13162a
   before tokens */
.y { border: 1px solid var(--color-ground); }
.z { background: hsl(from var(--status-waiting) h s l / 0.2); }
.q::after { content: "#1 red"; mask: url(#a1b2c3); }
.f { font-family: var(--font-app); box-shadow: inset 0 1px 0 var(--color-hairline), 0 2px 4px var(--color-ground); }
.g { --card-pad: 12px; border-width: 1px; border-width: 0 1px 1px 1px; box-shadow: 2px 0 4px var(--color-ground); }
.p { --pad: 0 0 0 3px; padding: var(--pad); border-width: 0 0 3px; box-shadow: var(--lift); --lift: 0 2px 6px var(--color-ground); }
.h { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-hairline) 60%, 4px 0); }
.a { --w: 1px; border-width: var(--w); }
.b { --w: 0 0 0 3px; }
.e { border-width: 1px var(--bw, calc( 2px + 1px )); box-shadow: var(--soft, 0 1px 2px var(--color-ground)); }
a:hover { color: var(--color-text); }
.border-left:hover { color: var(--color-text); }
@media (max-width: 600px) { .w { white-space: nowrap; } }
`)
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

func TestResyncRemovesOnlyFilesTheOldPinCopied(t *testing.T) {
	root, fetch := synced(t)
	// The old pin also copied a licence the new one drops; someone also put
	// an unrelated file next to the fonts.
	prov, _ := ReadProvenance(root)
	prov.Files = append(prov.Files, ProvFile{Source: "App/Fonts/Old-OFL.txt", Dest: "public/fonts/Old-OFL.txt", SHA256: sum([]byte("x"))})
	data, _ := json.MarshalIndent(prov, "", "  ")
	for rel, content := range map[string][]byte{ProvenancePath: data, "public/fonts/Old-OFL.txt": []byte("x"), "public/fonts/mine.txt": []byte("y")} {
		if err := os.WriteFile(filepath.Join(root, rel), content, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if err := Sync(context.Background(), root, pin, fetch); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "public/fonts/Old-OFL.txt")); !os.IsNotExist(err) {
		t.Fatal("a file the old pin copied and the new one dropped was kept")
	}
	if _, err := os.Stat(filepath.Join(root, "public/fonts/mine.txt")); err != nil {
		t.Fatal("deleted a file the sync never copied")
	}
	// ...but Check flags it, since it would ship unchecked.
	if errs := Check(root); !strings.Contains(fmt.Sprint(errs), "public/fonts/mine.txt is not from herdrup") {
		t.Fatalf("got %v", errs)
	}
}

func TestSyncFailsWithoutTouchingFilesWhenAnAssetIsMissing(t *testing.T) {
	root, _ := synced(t)
	read := func(rel string) string {
		data, _ := os.ReadFile(filepath.Join(root, rel))
		return string(data)
	}
	prov, tokens := read(ProvenancePath), read(TokensCopy)
	// The new commit changes a colour but lacks the last asset.
	files := herdrupFiles()
	files[TokensSource] = strings.Replace(fixture, "#E9A63C", "#FF0000", 1)
	delete(files, Assets[len(Assets)-1].Source)
	other := "fedcba9876543210fedcba9876543210fedcba98"
	if err := Sync(context.Background(), root, other, fakeHerdrup(other, files)); err == nil {
		t.Fatal("synced a commit that lacks an asset")
	}
	if read(ProvenancePath) != prov || read(TokensCopy) != tokens {
		t.Fatal("a failed sync changed files")
	}
}

func TestCheckFindsAnEditedAsset(t *testing.T) {
	root, _ := synced(t)
	edit(t, root, "public/herdrup/mascots.svg", "", "<!-- tweak -->")
	if errs := Check(root); !strings.Contains(fmt.Sprint(errs), "public/herdrup/mascots.svg differs from jerryfane/herdrup Tools/mascots/mascots.svg") {
		t.Fatalf("got %v", errs)
	}
}

func TestCheckFindsAnAssetLeftOutOfTheProvenance(t *testing.T) {
	root, _ := synced(t)
	prov, err := ReadProvenance(root)
	if err != nil {
		t.Fatal(err)
	}
	var kept []ProvFile
	for _, f := range prov.Files {
		if f.Source != "App/Assets.xcassets/AppIcon.appiconset/icon-1024.png" {
			kept = append(kept, f)
		}
	}
	prov.Files = kept
	data, _ := json.MarshalIndent(prov, "", "  ")
	if err := os.WriteFile(filepath.Join(root, ProvenancePath), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if errs := Check(root); !strings.Contains(fmt.Sprint(errs), "icon-1024.png is needed but not synced") {
		t.Fatalf("got %v", errs)
	}
}
