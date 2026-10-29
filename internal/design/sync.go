package design

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// Repo is where the tokens come from.
	Repo = "jerryfane/herdrup"
	// ProvenancePath records the pinned commit and every copied file.
	ProvenancePath = "third_party/herdrup/PROVENANCE.json"
	// TokensSource is tokens.json's path in Repo; TokensCopy is where the
	// pinned copy lives here.
	TokensSource = "design/tokens.json"
	TokensCopy   = "third_party/herdrup/design/tokens.json"
	// CSSPath and GoPath are generated from TokensCopy.
	CSSPath = "src/tokens.css"
	GoPath  = "internal/design/tokens_gen.go"
	// FontDir is served by Vite at /fonts.
	FontDir = "public/fonts"
)

// Provenance is the record of a sync.
type Provenance struct {
	Repo   string     `json:"repo"`
	Commit string     `json:"commit"`
	Files  []ProvFile `json:"files"`
}

// ProvFile is one copied file.
type ProvFile struct {
	Source string `json:"source"` // path in Repo at Commit
	Dest   string `json:"dest"`   // path in this repo
	SHA256 string `json:"sha256"`
}

// Fetcher reads a file of Repo at a commit.
type Fetcher func(ctx context.Context, commit, source string) ([]byte, error)

var fullSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

// GitHubFetcher reads from raw.githubusercontent.com; herdrup is public.
func GitHubFetcher(ctx context.Context, commit, source string) ([]byte, error) {
	url := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s", Repo, commit, source)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 32<<20))
}

func sum(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

// fontDest is where a font or licence file from Repo is copied to.
func fontDest(source string) string { return path.Join(FontDir, path.Base(source)) }

func writeFile(root, rel string, data []byte) error {
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

func readFile(root, rel string) ([]byte, error) {
	return os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
}

// Asset is a herdrup file the app reuses as it is (issue #4).
type Asset struct {
	Source string // path in Repo
	Dest   string // path here
}

// Assets are copied on every sync, next to the tokens and fonts.
var Assets = []Asset{
	// The 12 approved mascots, Herdy included, one <symbol id="p-<id>"> each.
	{"Tools/mascots/mascots.svg", "public/herdrup/mascots.svg"},
	// Each mascot as the app draws it in an avatar (AgentAvatarView renders
	// the Mascot-<id> image set, App/AgentAvatarViews.swift).
	{"App/Assets.xcassets/Mascot-herdy.imageset/mascot.svg", "public/herdrup/mascots/herdy.svg"},
	{"App/Assets.xcassets/Mascot-bot.imageset/mascot.svg", "public/herdrup/mascots/bot.svg"},
	{"App/Assets.xcassets/Mascot-blip.imageset/mascot.svg", "public/herdrup/mascots/blip.svg"},
	{"App/Assets.xcassets/Mascot-tri.imageset/mascot.svg", "public/herdrup/mascots/tri.svg"},
	{"App/Assets.xcassets/Mascot-squib.imageset/mascot.svg", "public/herdrup/mascots/squib.svg"},
	{"App/Assets.xcassets/Mascot-zag.imageset/mascot.svg", "public/herdrup/mascots/zag.svg"},
	{"App/Assets.xcassets/Mascot-cub.imageset/mascot.svg", "public/herdrup/mascots/cub.svg"},
	{"App/Assets.xcassets/Mascot-dome.imageset/mascot.svg", "public/herdrup/mascots/dome.svg"},
	{"App/Assets.xcassets/Mascot-pip.imageset/mascot.svg", "public/herdrup/mascots/pip.svg"},
	{"App/Assets.xcassets/Mascot-prism.imageset/mascot.svg", "public/herdrup/mascots/prism.svg"},
	{"App/Assets.xcassets/Mascot-nib.imageset/mascot.svg", "public/herdrup/mascots/nib.svg"},
	{"App/Assets.xcassets/Mascot-drop.imageset/mascot.svg", "public/herdrup/mascots/drop.svg"},
	{"design/herdrup-appicon.svg", "public/herdrup/appicon.svg"},
	// mygo builds every platform's app icon from this 1024x1024 PNG.
	{"App/Assets.xcassets/AppIcon.appiconset/icon-1024.png", "resources/icon.png"},
	// Bundled mermaid 11.17.2 (version and sha256 in its README), MIT.
	{"App/Resources/Mermaid/mermaid.min.js", "public/mermaid/mermaid.min.js"},
	{"App/Resources/Mermaid/Mermaid-LICENSE.txt", "public/mermaid/Mermaid-LICENSE.txt"},
	{"App/Resources/Mermaid/README.md", "public/mermaid/README.md"},
	{"App/Resources/Mermaid/mermaid.html", "public/mermaid/mermaid.html"},
}

// PublicDir belongs entirely to the sync: Vite copies all of it into the
// app, and every file in it today comes from herdrup, so a file there that
// no pin recorded would ship unchecked.
const PublicDir = "public"

// Sync copies tokens.json, its fonts and the shared assets from Repo at
// commit, records them in ProvenancePath and regenerates the CSS and Go
// files.
func Sync(ctx context.Context, root, commit string, fetch Fetcher) error {
	if !fullSHA.MatchString(commit) {
		return fmt.Errorf("pin a full 40-character commit, not %q", commit)
	}
	raw, err := fetch(ctx, commit, TokensSource)
	if err != nil {
		return err
	}
	t, err := Parse(raw)
	if err != nil {
		return err
	}
	fonts, err := t.FontFiles()
	if err != nil {
		return err
	}
	copies := []Asset{{TokensSource, TokensCopy}}
	for _, f := range fonts {
		copies = append(copies, Asset{f, fontDest(f)})
	}
	copies = append(copies, Assets...)
	// Fetch everything before writing anything, so a failed sync leaves
	// the old pin intact.
	contents := map[string][]byte{TokensSource: raw}
	for _, c := range copies[1:] {
		if contents[c.Source], err = fetch(ctx, commit, c.Source); err != nil {
			return err
		}
	}
	// Files the previous pin copied that this one does not are removed;
	// anything else in the tree is left alone.
	old, err := ReadProvenance(root)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	prov := Provenance{Repo: Repo, Commit: commit}
	for _, c := range copies {
		data := contents[c.Source]
		prov.Files = append(prov.Files, ProvFile{Source: c.Source, Dest: c.Dest, SHA256: sum(data)})
		if err := writeFile(root, c.Dest, data); err != nil {
			return err
		}
	}
	if err := removeDropped(root, old, prov); err != nil {
		return err
	}
	data, err := json.MarshalIndent(prov, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFile(root, ProvenancePath, append(data, '\n')); err != nil {
		return err
	}
	return Generate(root)
}

// removeDropped deletes the files old recorded that cur does not.
func removeDropped(root string, old, cur Provenance) error {
	keep := map[string]bool{}
	for _, f := range cur.Files {
		keep[f.Dest] = true
	}
	for _, f := range old.Files {
		if keep[f.Dest] || !validRepoPath(f.Dest) {
			continue
		}
		err := os.Remove(filepath.Join(root, filepath.FromSlash(f.Dest)))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// generatedNote is the first line of every generated file, then how to
// change a value.
func generatedNote(commit string) []string {
	return []string{
		fmt.Sprintf("Code generated by cmd/herdrup-sync from %s %s at %s. DO NOT EDIT.", Repo, TokensSource, commit),
		"To change a value, change it in herdrup and move the pin (see README).",
	}
}

// generated returns what CSSPath and GoPath must contain for the pinned
// tokens.
func generated(root string) (map[string][]byte, error) {
	prov, err := ReadProvenance(root)
	if err != nil {
		return nil, err
	}
	raw, err := readFile(root, TokensCopy)
	if err != nil {
		return nil, err
	}
	t, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	note := generatedNote(prov.Commit)
	css, err := t.CSS("/* " + note[0] + "\n   " + note[1] + " */\n\n")
	if err != nil {
		return nil, err
	}
	goSrc, err := t.GoConstants("// " + note[0] + "\n// " + note[1] + "\n\n")
	if err != nil {
		return nil, err
	}
	return map[string][]byte{CSSPath: css, GoPath: goSrc}, nil
}

// Generate rewrites CSSPath and GoPath from the pinned tokens.
func Generate(root string) error {
	out, err := generated(root)
	if err != nil {
		return err
	}
	for rel, data := range out {
		if err := writeFile(root, rel, data); err != nil {
			return err
		}
	}
	return nil
}

// ReadProvenance reads ProvenancePath.
func ReadProvenance(root string) (Provenance, error) {
	var p Provenance
	data, err := readFile(root, ProvenancePath)
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return p, fmt.Errorf("%s: %w", ProvenancePath, err)
	}
	if p.Repo != Repo || !fullSHA.MatchString(p.Commit) {
		return p, fmt.Errorf("%s: want repo %s and a full commit, have %q at %q", ProvenancePath, Repo, p.Repo, p.Commit)
	}
	for _, f := range p.Files {
		if !validRepoPath(f.Source) || !validRepoPath(f.Dest) {
			return p, fmt.Errorf("%s: %q -> %q is not a pair of clean relative paths", ProvenancePath, f.Source, f.Dest)
		}
	}
	return p, nil
}

// Check verifies, offline, that every copied file still matches its
// recorded hash, the file list matches what the tokens need, the generated
// files are current, and the stylesheets use tokens rather than colours.
func Check(root string) []error {
	var errs []error
	prov, err := ReadProvenance(root)
	if err != nil {
		return []error{err}
	}
	recorded := map[string]bool{}
	recordedDest := map[string]bool{}
	for _, f := range prov.Files {
		recorded[f.Source] = true
		recordedDest[f.Dest] = true
		data, err := readFile(root, f.Dest)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if got := sum(data); got != f.SHA256 {
			errs = append(errs, fmt.Errorf("%s differs from %s %s at %s (sha256 %s, recorded %s); do not edit synced files, change them in herdrup and re-sync",
				f.Dest, Repo, f.Source, prov.Commit[:12], got[:12], f.SHA256[:12]))
		}
	}
	if raw, err := readFile(root, TokensCopy); err == nil {
		if t, err := Parse(raw); err != nil {
			errs = append(errs, err)
		} else if need, err := t.FontFiles(); err != nil {
			errs = append(errs, err)
		} else {
			need = append([]string{TokensSource}, need...)
			for _, a := range Assets {
				need = append(need, a.Source)
			}
			for _, f := range need {
				if !recorded[f] {
					errs = append(errs, fmt.Errorf("%s is needed but not synced", f))
				}
			}
		}
	}
	if out, err := generated(root); err != nil {
		errs = append(errs, err)
	} else {
		for _, rel := range []string{CSSPath, GoPath} {
			have, _ := readFile(root, rel)
			if !bytes.Equal(have, out[rel]) {
				errs = append(errs, fmt.Errorf("%s is stale or edited; run go run ./cmd/herdrup-sync -generate", rel))
			}
		}
	}
	err = filepath.WalkDir(filepath.Join(root, PublicDir), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				// An unreadable folder could hide files; say so rather
				// than pass over it.
				errs = append(errs, fmt.Errorf("cannot inspect %s: %w", p, err))
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if rel = filepath.ToSlash(rel); !recordedDest[rel] {
			errs = append(errs, fmt.Errorf("%s is not from herdrup; remove it or add it to herdrup and re-sync", rel))
		}
		return nil
	})
	if err != nil {
		errs = append(errs, err)
	}
	return append(errs, LintStyles(root)...)
}

// VerifyUpstream re-reads every recorded file from Repo at the pinned commit
// and compares hashes, so a provenance file edited to match a local change
// is caught.
func VerifyUpstream(ctx context.Context, root string, fetch Fetcher) []error {
	prov, err := ReadProvenance(root)
	if err != nil {
		return []error{err}
	}
	var errs []error
	for _, f := range prov.Files {
		data, err := fetch(ctx, prov.Commit, f.Source)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if got := sum(data); got != f.SHA256 {
			errs = append(errs, fmt.Errorf("%s at %s has sha256 %s, but %s records %s", f.Source, prov.Commit[:12], got[:12], ProvenancePath, f.SHA256[:12]))
		}
	}
	return errs
}

var (
	comment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	// quoted strings and url() hold text, not colours: content:"#1",
	// url(#gradient).
	quotedOrURL = regexp.MustCompile(`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?i:url)\([^)]*\)`)
	// declaration is one "property: value" inside a rule or at-rule block.
	declaration = regexp.MustCompile(`(?i)([a-z-]+)\s*:\s*([^;{}]*)`)
	hexLiteral  = regexp.MustCompile(`#[0-9A-Fa-f]{3,8}\b`)
	// A colour function counts as a literal unless it derives from a
	// token: hsl(from var(--x) h s l).
	colourFunc = regexp.MustCompile(`(?i)\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*(from\s+var\()?`)
	word       = regexp.MustCompile(`[A-Za-z-]+`)
	// A coloured side stripe on a card is against the fleet UI rule.
	sideBorder = regexp.MustCompile(`(?i)^border-(?:left|right|inline-start|inline-end)(?:-color|-width|-style)?$`)
	// length is one CSS number with an optional unit: sign, decimals and
	// exponent allowed (+3px, .5em, 3e0px).
	length = regexp.MustCompile(`(?i)^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$`)
)

const stripe = "side stripe on a box; cards stay neutral (fleet UI rule)"

// splitLayers splits a comma-separated value at top-level commas.
func splitLayers(value string) []string {
	var layers []string
	depth, start := 0, 0
	for i, r := range value {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				layers = append(layers, value[start:i])
				start = i + 1
			}
		}
	}
	return append(layers, value[start:])
}

// insetStripe reports whether a box-shadow layer is an inset shadow offset
// sideways only. CSS allows "inset" before or after the lengths, and the
// colour may be a function whose own arguments are not offsets; calc() and
// the other maths functions count as non-zero lengths.
func insetStripe(layer string) bool {
	inset := false
	var lengths []float64
	for _, f := range topFields(strings.ToLower(layer)) {
		if f == "inset" {
			inset = true
		} else if n, ok := parseLength(f); ok {
			lengths = append(lengths, n)
		} else if mathFunc.MatchString(f) {
			lengths = append(lengths, 1)
		}
	}
	return inset && len(lengths) >= 2 && lengths[0] != 0 && lengths[1] == 0
}

var mathFunc = regexp.MustCompile(`^(?:calc|min|max|clamp)\(`)

// topFields splits a value at whitespace outside parentheses, so
// calc( 3px ) stays one field.
func topFields(value string) []string {
	var fields []string
	depth, start := 0, -1
	for i, r := range value {
		switch {
		case r == '(':
			depth++
		case r == ')':
			depth--
		case depth == 0 && (r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f'):
			if start >= 0 {
				fields = append(fields, value[start:i])
				start = -1
			}
			continue
		}
		if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		fields = append(fields, value[start:])
	}
	return fields
}

// parseLength reads a CSS length or number, ignoring the unit.
func parseLength(f string) (float64, bool) {
	m := length.FindStringSubmatch(f)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	return n, err == nil
}

// oneSidedWidths reports whether a 2-, 3- or 4-value border-width draws
// the left or right side (or both) and neither top nor bottom ("0 3px",
// "0 3px 0", "0 0 0 3px"). Keywords (thin, medium, thick), var() and
// calc() count as non-zero.
func oneSidedWidths(value string) bool {
	fields := topFields(strings.ToLower(value))
	if len(fields) < 2 || len(fields) > 4 {
		return false
	}
	nonZero := make([]bool, len(fields))
	for i, f := range fields {
		n, ok := parseLength(f)
		nonZero[i] = !ok || n != 0
	}
	// Expand to top, right, bottom, left as CSS does.
	var top, right, bottom, left bool
	switch len(nonZero) {
	case 2:
		top, right, bottom, left = nonZero[0], nonZero[1], nonZero[0], nonZero[1]
	case 3:
		top, right, bottom, left = nonZero[0], nonZero[1], nonZero[2], nonZero[1]
	case 4:
		top, right, bottom, left = nonZero[0], nonZero[1], nonZero[2], nonZero[3]
	}
	return !top && !bottom && (left || right)
}

var customName = regexp.MustCompile(`^\s*(--[A-Za-z0-9_-]+)\s*(?:,|$)`)

// maxExpansions bounds how many variants of one value are checked.
const maxExpansions = 256

// expandVars returns every value a declaration can take once the custom
// properties declared in the app's stylesheets are substituted, a few
// levels deep, so a stripe hidden behind var(--x) is still seen. Each
// declared value of a variable is tried, as is a var() fallback, since
// custom properties cascade per element and the lint cannot tell which
// rule applies. Unknown references without a fallback (tokens) are left
// as they are.
func expandVars(value string, custom map[string][]string) []string {
	return expandDepth(value, custom, 5)
}

func expandDepth(value string, custom map[string][]string, depth int) []string {
	lower := strings.ToLower(value)
	for i := strings.Index(lower, "var("); i >= 0; {
		// Find the matching close paren.
		end, d := -1, 0
		for j := i + 3; j < len(value); j++ {
			if value[j] == '(' {
				d++
			} else if value[j] == ')' {
				d--
				if d == 0 {
					end = j
					break
				}
			}
		}
		if end < 0 {
			break
		}
		inner := value[i+4 : end]
		m := customName.FindStringSubmatch(inner)
		if m == nil || depth == 0 {
			next := strings.Index(lower[end:], "var(")
			if next < 0 {
				break
			}
			i = end + next
			continue
		}
		var subs []string
		subs = append(subs, custom[m[1]]...)
		if comma := strings.IndexByte(inner, ','); comma >= 0 {
			subs = append(subs, inner[comma+1:])
		}
		if len(subs) == 0 {
			next := strings.Index(lower[end:], "var(")
			if next < 0 {
				break
			}
			i = end + next
			continue
		}
		head, tail := value[:i], value[end+1:]
		var out []string
		for _, s := range subs {
			for _, v := range expandDepth(s, custom, depth-1) {
				for _, t := range expandDepth(tail, custom, depth) {
					if len(out) == maxExpansions {
						return out
					}
					out = append(out, head+v+t)
				}
			}
		}
		return out
	}
	return []string{value}
}

// namedColours are the CSS colour keywords (CSS Color 4) plus the system
// colours most likely to slip in. currentColor, transparent and the CSS-wide
// keywords are allowed.
var namedColours = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range strings.Fields(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
		blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson
		cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
		darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
		darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
		forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink
		indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
		lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
		lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta
		maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
		mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
		navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
		paleturquoise palevioletred papayawhip peru pink plum powderblue purple rebeccapurple red rosybrown
		royalblue saddlebrown salmon seagreen seashell sienna silver skyblue slateblue slategray slategrey snow
		springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
		yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field
		fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor
		accentcolortext`) {
		m[c] = true
	}
	return m
}()

// textProperties hold names, not colours ("font-family: Tomato Sans").
var textProperties = map[string]bool{
	"font-family": true, "font": true, "content": true, "grid-template-areas": true, "grid-area": true,
	"animation": true, "animation-name": true, "transition-property": true, "will-change": true,
	"counter-reset": true, "counter-increment": true, "quotes": true, "src": true,
}

// lintDeclaration returns the problems in one CSS declaration.
func lintDeclaration(prop, value string, custom map[string][]string) []string {
	prop = strings.ToLower(prop)
	// Custom properties are linted too: --accent: #ce58a4 is a raw colour
	// however it is later used.
	var out []string
	if sideBorder.MatchString(prop) || isStripe(prop, expandVars(value, custom)) {
		out = append(out, stripe)
	}
	if textProperties[prop] {
		return out
	}
	if m := hexLiteral.FindString(value); m != "" {
		out = append(out, fmt.Sprintf("colour literal %q; use a token variable from %s", m, CSSPath))
	}
	for _, m := range colourFunc.FindAllStringSubmatch(value, -1) {
		if m[2] == "" {
			out = append(out, fmt.Sprintf("colour literal %q; use a token variable from %s", m[1]+"(", CSSPath))
		}
	}
	for _, w := range word.FindAllString(value, -1) {
		if namedColours[strings.ToLower(w)] {
			out = append(out, fmt.Sprintf("colour literal %q; use a token variable from %s", w, CSSPath))
		}
	}
	return out
}

// isStripe reports whether any variant of a border-width or box-shadow
// value draws a side stripe.
func isStripe(prop string, variants []string) bool {
	for _, v := range variants {
		if prop == "border-width" && oneSidedWidths(v) {
			return true
		}
		if prop == "box-shadow" {
			for _, layer := range splitLayers(v) {
				if insetStripe(layer) {
					return true
				}
			}
		}
	}
	return false
}

// LintStyles checks every stylesheet under src except the generated one:
// colours must come from token variables, and cards get no coloured side
// stripes.
func LintStyles(root string) []error {
	var errs []error
	var files []string
	_ = filepath.WalkDir(filepath.Join(root, "src"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".css") {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	blank := func(s string) string { return strings.Repeat(" ", len(s)) }
	type decl struct {
		rel       string
		line      int
		prop, val string
		rule      int
	}
	var decls []decl
	custom := map[string][]string{}
	// local holds the custom properties each rule block declares itself.
	local := map[int]map[string][]string{}
	rules := 0
	for _, p := range files {
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if rel == CSSPath {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		// Blank comments, strings and url() in place so offsets still map
		// to the original lines.
		text := comment.ReplaceAllStringFunc(string(data), func(c string) string {
			return strings.Map(func(r rune) rune {
				if r == '\n' {
					return r
				}
				return ' '
			}, c)
		})
		text = quotedOrURL.ReplaceAllStringFunc(text, blank)
		// block[i] numbers the innermost { } block holding offset i.
		block := make([]int, len(text))
		stack := []int{-1}
		for i := range len(text) {
			switch text[i] {
			case '{':
				rules++
				stack = append(stack, rules)
			case '}':
				if len(stack) > 1 {
					stack = stack[:len(stack)-1]
				}
			}
			block[i] = stack[len(stack)-1]
		}
		for _, loc := range declaration.FindAllStringSubmatchIndex(text, -1) {
			// A selector with a pseudo-class (a:hover {) is not a declaration.
			if end := loc[1]; end < len(text) && text[end] == '{' {
				continue
			}
			d := decl{rel, strings.Count(text[:loc[0]], "\n") + 1, text[loc[2]:loc[3]], strings.TrimSpace(text[loc[4]:loc[5]]), block[loc[0]]}
			if strings.HasPrefix(d.prop, "--") {
				custom[d.prop] = append(custom[d.prop], d.val)
				if local[d.rule] == nil {
					local[d.rule] = map[string][]string{}
				}
				local[d.rule][d.prop] = append(local[d.rule][d.prop], d.val)
			}
			decls = append(decls, d)
		}
	}
	// Custom properties are collected from every stylesheet first, so a
	// var() resolves wherever it is declared. A variable the rule itself
	// declares resolves to that rule's values only; any other resolves to
	// every value declared anywhere, since the lint cannot tell which rule
	// reaches the element.
	for _, d := range decls {
		scope := custom
		if own := local[d.rule]; own != nil {
			scope = make(map[string][]string, len(custom))
			maps.Copy(scope, custom)
			maps.Copy(scope, own)
		}
		for _, problem := range lintDeclaration(d.prop, d.val, scope) {
			errs = append(errs, fmt.Errorf("%s:%d: %s", d.rel, d.line, problem))
		}
	}
	return errs
}
