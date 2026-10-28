// Package design turns herdrup's shared design tokens (design/tokens.json
// in jerryfane/herdrup) into the desktop app's CSS variables and Go
// constants. The format is described in that repo's design/README.md.
package design

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// SchemaVersion is the tokens format this package understands.
const SchemaVersion = 1

// Tokens is a parsed tokens.json.
type Tokens struct {
	root map[string]any
}

// FontFace is one face of a font, with its file in the herdrup repo.
type FontFace struct {
	Family string
	Weight string
	File   string // path in jerryfane/herdrup, e.g. App/Fonts/Geist-Regular.ttf
}

var refPattern = regexp.MustCompile(`^\{([A-Za-z0-9_.]+)\}$`)

// Parse decodes and validates tokens.json: the schema version, the known
// top-level groups, and every reference.
func Parse(data []byte) (*Tokens, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var root map[string]any
	if err := dec.Decode(&root); err != nil {
		return nil, fmt.Errorf("tokens.json: %w", err)
	}
	if v, ok := root["schema_version"].(json.Number); !ok || v.String() != fmt.Sprint(SchemaVersion) {
		return nil, fmt.Errorf("tokens.json: schema_version %v, this build understands %d", root["schema_version"], SchemaVersion)
	}
	known := map[string]bool{"color": true, "status": true, "group": true, "agentGradient": true, "chat": true, "font": true, "type": true}
	for k := range root {
		if k == "schema_version" || strings.HasPrefix(k, "_") {
			continue
		}
		if !known[k] {
			return nil, fmt.Errorf("tokens.json: unknown group %q; update internal/design before syncing it", k)
		}
	}
	t := &Tokens{root: root}
	if err := t.checkRefs(root, nil); err != nil {
		return nil, err
	}
	return t, nil
}

// checkRefs resolves every reference once, so dangling ones and cycles fail
// at parse time.
func (t *Tokens) checkRefs(v any, at []string) error {
	switch v := v.(type) {
	case map[string]any:
		for k, child := range v {
			if strings.HasPrefix(k, "_") {
				continue
			}
			if err := t.checkRefs(child, append(at, k)); err != nil {
				return err
			}
		}
	case []any:
		for i, child := range v {
			if err := t.checkRefs(child, append(at, fmt.Sprint(i))); err != nil {
				return err
			}
		}
	case string:
		if _, err := t.resolve(v, nil); err != nil {
			return fmt.Errorf("tokens.json %s: %w", strings.Join(at, "."), err)
		}
	}
	return nil
}

// lookup returns the value at a dot path.
func (t *Tokens) lookup(p string) (any, bool) {
	var v any = t.root
	for _, seg := range strings.Split(p, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return nil, false
		}
		if v, ok = m[seg]; !ok {
			return nil, false
		}
	}
	return v, true
}

// resolve follows references until a literal leaf.
func (t *Tokens) resolve(v any, seen []string) (any, error) {
	s, ok := v.(string)
	if !ok {
		return v, nil
	}
	m := refPattern.FindStringSubmatch(s)
	if m == nil {
		return s, nil
	}
	target := m[1]
	for _, p := range seen {
		if p == target {
			return nil, fmt.Errorf("reference cycle through {%s}", target)
		}
	}
	next, ok := t.lookup(target)
	if !ok {
		return nil, fmt.Errorf("dangling reference {%s}", target)
	}
	switch next.(type) {
	case map[string]any, []any, nil:
		return nil, fmt.Errorf("reference {%s} is not a single token", target)
	}
	return t.resolve(next, append(seen, target))
}

func (t *Tokens) group(path string) (map[string]any, error) {
	v, ok := t.lookup(path)
	if !ok || v == nil {
		return nil, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("tokens.json %s: want an object", path)
	}
	return m, nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		if !strings.HasPrefix(k, "_") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// kebab turns a camelCase token key into a CSS name part.
func kebab(s string) string {
	var b strings.Builder
	for i, r := range s {
		if unicode.IsUpper(r) {
			if i > 0 {
				b.WriteByte('-')
			}
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// cssName is the variable a token path becomes. The theme segment of the
// colour and chat groups is dropped: dark values are the defaults and light
// ones override them under [data-theme="light"].
func cssName(p string) string {
	segs := strings.Split(p, ".")
	if len(segs) == 3 && (segs[0] == "color" || segs[0] == "chat") && (segs[1] == "dark" || segs[1] == "light") {
		segs = []string{segs[0], segs[2]}
	}
	parts := make([]string, len(segs))
	for i, s := range segs {
		parts[i] = kebab(s)
	}
	return "--" + strings.Join(parts, "-")
}

var hexColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// cssValue renders a leaf; a reference becomes var() of its target.
func (t *Tokens) cssValue(p string, v any) (string, error) {
	switch v := v.(type) {
	case json.Number:
		return v.String(), nil
	case bool:
		return fmt.Sprint(v), nil
	case string:
		if m := refPattern.FindStringSubmatch(v); m != nil {
			return "var(" + cssName(m[1]) + ")", nil
		}
		if hexColor.MatchString(v) {
			return strings.ToLower(v), nil
		}
		return "", fmt.Errorf("tokens.json %s: %q is not a colour or reference", p, v)
	}
	return "", fmt.Errorf("tokens.json %s: unsupported value %v", p, v)
}

// FontFaces lists every font face, in a stable order.
func (t *Tokens) FontFaces() ([]FontFace, error) {
	fonts, err := t.group("font")
	if err != nil {
		return nil, err
	}
	var faces []FontFace
	for _, name := range sortedKeys(fonts) {
		f, ok := fonts[name].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("tokens.json font.%s: want an object", name)
		}
		family, _ := f["family"].(string)
		fm, ok := f["faces"].(map[string]any)
		if family == "" || !ok {
			return nil, fmt.Errorf("tokens.json font.%s: needs family and faces", name)
		}
		for _, w := range sortedKeys(fm) {
			face, _ := fm[w].(map[string]any)
			file, _ := face["file"].(string)
			if file == "" {
				return nil, fmt.Errorf("tokens.json font.%s.faces.%s: needs file", name, w)
			}
			faces = append(faces, FontFace{Family: family, Weight: w, File: file})
		}
	}
	return faces, nil
}

// FontFiles lists every file the fonts need: faces and licences.
func (t *Tokens) FontFiles() ([]string, error) {
	faces, err := t.FontFaces()
	if err != nil {
		return nil, err
	}
	var files []string
	for _, f := range faces {
		files = append(files, f.File)
	}
	fonts, _ := t.group("font")
	for _, name := range sortedKeys(fonts) {
		f := fonts[name].(map[string]any)
		lic, _ := f["license"].(string)
		if lic == "" {
			return nil, fmt.Errorf("tokens.json font.%s: needs license", name)
		}
		files = append(files, lic)
	}
	return files, nil
}

// FontURL is where the page loads a font file from: Vite serves public/
// at the root, and Sync writes fonts to public/fonts.
func FontURL(file string) string { return "/fonts/" + path.Base(file) }

// CSS renders the tokens as CSS custom properties plus @font-face rules.
func (t *Tokens) CSS(header string) ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(header)
	faces, err := t.FontFaces()
	if err != nil {
		return nil, err
	}
	for _, f := range faces {
		fmt.Fprintf(&b, "@font-face {\n  font-family: %q;\n  src: url(%q) format(\"truetype\");\n  font-weight: %s;\n  font-style: normal;\n  font-display: swap;\n}\n\n",
			f.Family, FontURL(f.File), f.Weight)
	}

	b.WriteString(":root {\n")
	emit := func(name, value string) { fmt.Fprintf(&b, "  %s: %s;\n", name, value) }
	leaves := func(prefix string) error {
		g, err := t.group(prefix)
		if err != nil || g == nil {
			return err
		}
		for _, k := range sortedKeys(g) {
			p := prefix + "." + k
			v, err := t.cssValue(p, g[k])
			if err != nil {
				return err
			}
			emit(cssName(p), v)
		}
		return nil
	}
	for _, prefix := range []string{"color.dark", "status", "group", "chat.dark"} {
		if err := leaves(prefix); err != nil {
			return nil, err
		}
	}

	grads, err := t.group("agentGradient")
	if err != nil {
		return nil, err
	}
	for _, k := range sortedKeys(grads) {
		stops, ok := grads[k].([]any)
		if !ok || len(stops) != 2 {
			return nil, fmt.Errorf("tokens.json agentGradient.%s: want two colours", k)
		}
		var css [2]string
		for i, s := range stops {
			if css[i], err = t.cssValue(fmt.Sprintf("agentGradient.%s.%d", k, i), s); err != nil {
				return nil, err
			}
		}
		// The stops run from the top leading corner.
		emit(cssName("agentGradient."+k), fmt.Sprintf("linear-gradient(135deg, %s, %s)", css[0], css[1]))
	}

	fonts, err := t.group("font")
	if err != nil {
		return nil, err
	}
	for _, name := range sortedKeys(fonts) {
		f := fonts[name].(map[string]any)
		stack := []string{fmt.Sprintf("%q", f["family"])}
		fallback, _ := f["fallback"].([]any)
		for _, fb := range fallback {
			s, _ := fb.(string)
			if strings.ContainsAny(s, " ") {
				s = fmt.Sprintf("%q", s)
			}
			stack = append(stack, s)
		}
		emit("--font-"+kebab(name), strings.Join(stack, ", "))
	}

	types, err := t.group("type")
	if err != nil {
		return nil, err
	}
	for _, name := range sortedKeys(types) {
		r, ok := types[name].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("tokens.json type.%s: want an object", name)
		}
		font, _ := r["font"].(string)
		f, ok := fonts[font].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("tokens.json type.%s: font %q is not a key of font", name, font)
		}
		size, _ := r["size"].(json.Number)
		weight, _ := r["weight"].(json.Number)
		if faces, _ := f["faces"].(map[string]any); faces[weight.String()] == nil {
			return nil, fmt.Errorf("tokens.json type.%s: font.%s has no %s face", name, font, weight)
		}
		transform := "none"
		if up, _ := r["uppercase"].(bool); up {
			transform = "uppercase"
		}
		base := "--type-" + kebab(name)
		emit(base+"-font", "var(--font-"+kebab(font)+")")
		emit(base+"-size", size.String()+"px")
		emit(base+"-weight", weight.String())
		emit(base+"-transform", transform)
	}
	b.WriteString("}\n")

	light := []string{"color.light", "chat.light"}
	var lightBody bytes.Buffer
	for _, prefix := range light {
		g, err := t.group(prefix)
		if err != nil {
			return nil, err
		}
		for _, k := range sortedKeys(g) {
			p := prefix + "." + k
			v, err := t.cssValue(p, g[k])
			if err != nil {
				return nil, err
			}
			fmt.Fprintf(&lightBody, "  %s: %s;\n", cssName(p), v)
		}
	}
	if lightBody.Len() > 0 {
		b.WriteString("\n:root[data-theme=\"light\"] {\n")
		b.Write(lightBody.Bytes())
		b.WriteString("}\n")
	}
	return b.Bytes(), nil
}

// GoConstants renders the colours Go code needs (the window background
// shown before the page paints) as constants.
func (t *Tokens) GoConstants(header string) ([]byte, error) {
	dark, err := t.group("color.dark")
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.WriteString(header)
	b.WriteString("package design\n\nconst (\n")
	for _, k := range sortedKeys(dark) {
		s, ok := dark[k].(string)
		if !ok || !hexColor.MatchString(s) {
			continue
		}
		fmt.Fprintf(&b, "\tColor%s = %q\n", strings.ToUpper(k[:1])+k[1:], s)
	}
	b.WriteString(")\n")
	return format.Source(b.Bytes())
}
