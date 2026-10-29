package apigen

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// node is one JSON Schema node of herdr's schema. It is decoded strictly:
// a keyword the generator does not know fails the load instead of being
// silently dropped from the Go types.
type node struct {
	// Any is the boolean schema `true`: any JSON value.
	Any bool `json:"-"`

	Ref                  string            `json:"$ref"`
	Type                 typeList          `json:"type"`
	Format               string            `json:"format"`
	Const                json.RawMessage   `json:"const"`
	Enum                 []json.RawMessage `json:"enum"`
	Properties           map[string]*node  `json:"properties"`
	Required             []string          `json:"required"`
	Items                *node             `json:"items"`
	AdditionalProperties *node             `json:"additionalProperties"`
	OneOf                []*node           `json:"oneOf"`
	AnyOf                []*node           `json:"anyOf"`
	Defs                 map[string]*node  `json:"$defs"`
	Default              json.RawMessage   `json:"default"`
	Description          string            `json:"description"`
	Title                string            `json:"title"`
	Schema               string            `json:"$schema"`
	Pattern              string            `json:"pattern"`
	Minimum              json.RawMessage   `json:"minimum"`
	Maximum              json.RawMessage   `json:"maximum"`
	MaxProperties        json.RawMessage   `json:"maxProperties"`
	PropertyNames        *node             `json:"propertyNames"`
}

func (n *node) UnmarshalJSON(b []byte) error {
	switch string(bytes.TrimSpace(b)) {
	case "true":
		*n = node{Any: true}
		return nil
	case "false":
		return errors.New("the schema `false` is not supported")
	}
	type plain node
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	return dec.Decode((*plain)(n))
}

// typeList is a JSON Schema "type": one name or a list of names.
type typeList []string

func (t *typeList) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*t = typeList{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return fmt.Errorf("type: %w", err)
	}
	*t = many
	return nil
}

// document is the whole schema file.
type document struct {
	Schema        string           `json:"$schema"`
	Protocol      int              `json:"protocol"`
	SchemaVersion int              `json:"schema_version"`
	Schemas       map[string]*node `json:"schemas"`
	Title         string           `json:"title"`
}

// Kind is how a named schema type maps to Go.
type Kind int

const (
	// KindStruct is an object: a Go struct.
	KindStruct Kind = iota
	// KindEnum is a set of strings: a named string type with constants.
	KindEnum
	// KindUnion is a oneOf of objects told apart by one string property
	// (the tag): a wrapper struct holding one variant struct.
	KindUnion
	// KindRaw is a union with no tag (anyOf, or mixed scalars): raw JSON.
	KindRaw
	// KindRequest is the request envelope: a method name and its params.
	KindRequest
	// KindFlat is an object whose payload is one of several flattened
	// objects: their properties merged into one struct.
	KindFlat
)

// Model is the schema reduced to the Go types it generates.
type Model struct {
	Protocol      int
	SchemaVersion int
	// Types are every named type: the $defs of all sections, de-duplicated
	// by name, and each section's root under its title.
	Types map[string]*Type
}

// Type is one named Go type.
type Type struct {
	Name string
	Kind Kind
	Doc  string
	// Fields of a struct or flat type, and the envelope fields of a request.
	Fields []Field
	// Values of an enum.
	Values []EnumValue
	// TagKey and Variants of a union.
	TagKey   string
	Variants []*Variant
	// Alternatives of a raw union, described for its doc comment; the
	// $ref'd names for a union of refs.
	Alternatives []string
	// Methods of the request envelope, in schema order.
	Methods []RequestMethod
}

// Field is one struct field.
type Field struct {
	GoName string
	JSON   string
	GoType string
	// Omit is the json tag option: "", "omitempty" or "omitzero".
	Omit string
	Doc  string
}

// EnumValue is one enum constant.
type EnumValue struct {
	GoName string
	Value  string
	Doc    string
}

// Variant is one member of a tagged union.
type Variant struct {
	Tag    string
	GoName string
	Doc    string
	Fields []Field
}

// RequestMethod is one method of the request envelope.
type RequestMethod struct {
	Name   string
	Params string // Go type of its params
}

var refPattern = regexp.MustCompile(`^#/schemas/[a-z_]+/\$defs/([A-Za-z][A-Za-z0-9]*)$`)

// entry is a named schema with where it came from.
type entry struct {
	name    string
	section string
	n       *node
	shape   string
}

// Load parses herdr's schema and builds the Go model of every type in it.
func Load(schema []byte) (*Model, error) {
	dec := json.NewDecoder(bytes.NewReader(schema))
	dec.DisallowUnknownFields()
	var doc document
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("parse schema: %w", err)
	}
	if doc.Protocol <= 0 || doc.SchemaVersion <= 0 {
		return nil, fmt.Errorf("schema header: want positive protocol and schema_version, have %d and %d", doc.Protocol, doc.SchemaVersion)
	}
	if len(doc.Schemas) == 0 {
		return nil, errors.New("schema has no sections")
	}
	pool := map[string]*entry{}
	add := func(e *entry) error {
		if !goIdent.MatchString(e.name) {
			return fmt.Errorf("%s: type name %q is not an exported Go identifier", e.section, e.name)
		}
		e.shape = shape(e.n)
		if have, ok := pool[e.name]; ok {
			if have.shape != e.shape {
				return fmt.Errorf("%s is defined differently in sections %s and %s", e.name, have.section, e.section)
			}
			return nil
		}
		pool[e.name] = e
		return nil
	}
	for _, sec := range sortedKeys(doc.Schemas) {
		root := doc.Schemas[sec]
		for _, name := range sortedKeys(root.Defs) {
			if err := add(&entry{name: name, section: sec, n: root.Defs[name]}); err != nil {
				return nil, err
			}
		}
		if root.Title == "" {
			return nil, fmt.Errorf("section %s has no title to name its type", sec)
		}
		body := *root
		body.Defs = nil
		if err := add(&entry{name: root.Title, section: sec, n: &body}); err != nil {
			return nil, err
		}
	}
	b := &builder{pool: pool, kinds: map[string]Kind{}}
	for _, name := range sortedKeys(pool) {
		k, err := b.kindOf(pool[name].n)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		b.kinds[name] = k
	}
	m := &Model{Protocol: doc.Protocol, SchemaVersion: doc.SchemaVersion, Types: map[string]*Type{}}
	for _, name := range sortedKeys(pool) {
		t, err := b.build(name, pool[name].n)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		m.Types[name] = t
	}
	if err := m.checkNames(); err != nil {
		return nil, err
	}
	return m, nil
}

// shape is n's structure for comparing same-named definitions across
// sections: annotations (description, title, $schema) are dropped and
// references keep only the type name, since each section points into its
// own $defs.
func shape(n *node) string {
	var walk func(n *node) any
	walk = func(n *node) any {
		if n == nil {
			return nil
		}
		if n.Any {
			return true
		}
		out := map[string]any{}
		if n.Ref != "" {
			ref := n.Ref
			if m := refPattern.FindStringSubmatch(ref); m != nil {
				ref = m[1]
			}
			out["$ref"] = ref
		}
		if len(n.Type) > 0 {
			out["type"] = []string(n.Type)
		}
		for k, v := range map[string]string{"format": n.Format, "pattern": n.Pattern} {
			if v != "" {
				out[k] = v
			}
		}
		for k, v := range map[string]json.RawMessage{"const": n.Const, "default": n.Default, "minimum": n.Minimum, "maximum": n.Maximum, "maxProperties": n.MaxProperties} {
			if v != nil {
				out[k] = v
			}
		}
		if n.Enum != nil {
			out["enum"] = n.Enum
		}
		if n.Properties != nil {
			props := map[string]any{}
			for k, p := range n.Properties {
				props[k] = walk(p)
			}
			out["properties"] = props
		}
		if n.Required != nil {
			req := append([]string(nil), n.Required...)
			sort.Strings(req)
			out["required"] = req
		}
		for k, v := range map[string]*node{"items": n.Items, "additionalProperties": n.AdditionalProperties, "propertyNames": n.PropertyNames} {
			if v != nil {
				out[k] = walk(v)
			}
		}
		for k, alts := range map[string][]*node{"oneOf": n.OneOf, "anyOf": n.AnyOf} {
			if alts != nil {
				l := make([]any, len(alts))
				for i, a := range alts {
					l[i] = walk(a)
				}
				out[k] = l
			}
		}
		return out
	}
	b, _ := json.Marshal(walk(n))
	return string(b)
}

type builder struct {
	pool  map[string]*entry
	kinds map[string]Kind
}

// refName resolves a $ref to a type in the pool.
func (b *builder) refName(ref string) (string, error) {
	m := refPattern.FindStringSubmatch(ref)
	if m == nil {
		return "", fmt.Errorf("unsupported $ref %q", ref)
	}
	if _, ok := b.pool[m[1]]; !ok {
		return "", fmt.Errorf("$ref %q names no definition", ref)
	}
	return m[1], nil
}

func (n *node) alternatives() []*node {
	if n.OneOf != nil {
		return n.OneOf
	}
	return n.AnyOf
}

func (n *node) isType(name string) bool { return len(n.Type) == 1 && n.Type[0] == name }

// stringValues returns the strings an all-strings union or enum allows, or
// ok=false when any alternative is something else.
func stringValues(n *node) (vals []EnumValue, ok bool) {
	addEnum := func(m *node) bool {
		if !m.isType("string") || m.Enum == nil || len(m.alternatives()) > 0 || m.Properties != nil {
			return false
		}
		for _, raw := range m.Enum {
			var s string
			if json.Unmarshal(raw, &s) != nil {
				return false
			}
			vals = append(vals, EnumValue{Value: s})
		}
		return true
	}
	if n.Enum != nil {
		return vals, addEnum(n)
	}
	alts := n.alternatives()
	if len(alts) == 0 || n.Properties != nil || len(n.Type) > 0 {
		return nil, false
	}
	for _, a := range alts {
		if a.Any {
			return nil, false
		}
		if a.Const != nil {
			var s string
			if !a.isType("string") || json.Unmarshal(a.Const, &s) != nil {
				return nil, false
			}
			vals = append(vals, EnumValue{Value: s, Doc: a.Description})
			continue
		}
		if !addEnum(a) {
			return nil, false
		}
	}
	return vals, true
}

// tagKey returns the property every alternative of n fixes to a distinct
// string constant, or "" when there is not exactly one such property.
func tagKey(n *node) string {
	alts := n.OneOf
	if len(alts) == 0 {
		return ""
	}
	var cands []string
	for _, a := range alts {
		if a.Any || a.Properties == nil || !a.isType("object") {
			return ""
		}
	}
	for k := range alts[0].Properties {
		seen := map[string]bool{}
		ok := true
		for _, a := range alts {
			p := a.Properties[k]
			var s string
			if p == nil || p.Any || p.Const == nil || json.Unmarshal(p.Const, &s) != nil || seen[s] || !contains(a.Required, k) {
				ok = false
				break
			}
			seen[s] = true
		}
		if ok {
			cands = append(cands, k)
		}
	}
	if len(cands) != 1 {
		return ""
	}
	return cands[0]
}

// isRequest reports whether n is the request envelope: an object whose
// oneOf alternatives each fix "method" and reference their "params".
func isRequest(n *node) bool {
	if len(n.OneOf) == 0 || n.Properties == nil {
		return false
	}
	for _, a := range n.OneOf {
		if a.Any || len(a.Properties) != 2 {
			return false
		}
		m, p := a.Properties["method"], a.Properties["params"]
		if m == nil || p == nil || m.Const == nil || p.Ref == "" {
			return false
		}
	}
	return true
}

func (b *builder) kindOf(n *node) (Kind, error) {
	if n.Any {
		return 0, errors.New("a named type may not be the schema `true`")
	}
	switch {
	case isRequest(n):
		return KindRequest, nil
	case n.Properties != nil && n.AnyOf != nil:
		for _, a := range n.AnyOf {
			if a.Ref == "" {
				return 0, errors.New("a flattened anyOf must list $refs")
			}
		}
		return KindFlat, nil
	case n.isType("object") && n.alternatives() == nil:
		if n.AdditionalProperties != nil {
			return 0, errors.New("a named map type is not supported")
		}
		return KindStruct, nil
	}
	if _, ok := stringValues(n); ok {
		return KindEnum, nil
	}
	if n.alternatives() == nil {
		return 0, fmt.Errorf("unsupported shape %s", shape(n))
	}
	if len(n.Type) > 0 || n.Properties != nil {
		return 0, errors.New("a union may not also have a type or properties")
	}
	if tagKey(n) != "" {
		return KindUnion, nil
	}
	return KindRaw, nil
}

func (b *builder) build(name string, n *node) (*Type, error) {
	t := &Type{Name: name, Kind: b.kinds[name], Doc: n.Description}
	switch t.Kind {
	case KindStruct:
		fields, err := b.fields(n, "")
		if err != nil {
			return nil, err
		}
		t.Fields = fields
	case KindEnum:
		vals, _ := stringValues(n)
		seen := map[string]bool{}
		for i := range vals {
			if seen[vals[i].Value] {
				return nil, fmt.Errorf("value %q is listed twice", vals[i].Value)
			}
			seen[vals[i].Value] = true
			vals[i].GoName = name + camel(vals[i].Value)
		}
		t.Values = vals
	case KindUnion:
		t.TagKey = tagKey(n)
		for _, a := range n.OneOf {
			var tag string
			_ = json.Unmarshal(a.Properties[t.TagKey].Const, &tag)
			fields, err := b.fields(a, t.TagKey)
			if err != nil {
				return nil, fmt.Errorf("variant %q: %w", tag, err)
			}
			t.Variants = append(t.Variants, &Variant{Tag: tag, GoName: name + camel(tag), Doc: a.Description, Fields: fields})
		}
	case KindRaw:
		for _, a := range n.alternatives() {
			t.Alternatives = append(t.Alternatives, b.describe(a))
		}
	case KindRequest:
		fields, err := b.fields(n, "")
		if err != nil {
			return nil, err
		}
		t.Fields = fields
		for _, a := range n.OneOf {
			var method string
			if err := json.Unmarshal(a.Properties["method"].Const, &method); err != nil {
				return nil, fmt.Errorf("method const: %w", err)
			}
			params, err := b.refName(a.Properties["params"].Ref)
			if err != nil {
				return nil, fmt.Errorf("method %s: %w", method, err)
			}
			t.Methods = append(t.Methods, RequestMethod{Name: method, Params: params})
		}
	case KindFlat:
		fields, err := b.flatFields(n)
		if err != nil {
			return nil, err
		}
		t.Fields = fields
		for _, a := range n.AnyOf {
			ref, _ := b.refName(a.Ref)
			t.Alternatives = append(t.Alternatives, ref)
		}
	}
	return t, nil
}

// describe names a union alternative for a doc comment.
func (b *builder) describe(n *node) string {
	switch {
	case n.Any:
		return "any JSON value"
	case n.Ref != "":
		name, _ := b.refName(n.Ref)
		return name
	case n.Properties != nil:
		return "object {" + strings.Join(sortedKeys(n.Properties), ", ") + "}"
	case n.Format != "":
		return strings.Join(n.Type, "|") + " (" + n.Format + ")"
	case n.Pattern != "":
		return strings.Join(n.Type, "|") + " matching " + n.Pattern
	}
	return strings.Join(n.Type, "|")
}

// fields maps an object's properties, minus skip (a union's tag), to
// struct fields in property-name order.
func (b *builder) fields(n *node, skip string) ([]Field, error) {
	var out []Field
	seen := map[string]string{}
	for _, name := range sortedKeys(n.Properties) {
		if name == skip {
			continue
		}
		f, err := b.field(name, n.Properties[name], contains(n.Required, name))
		if err != nil {
			return nil, fmt.Errorf("property %s: %w", name, err)
		}
		if other, dup := seen[f.GoName]; dup {
			return nil, fmt.Errorf("properties %s and %s both map to Go field %s", other, name, f.GoName)
		}
		seen[f.GoName] = name
		out = append(out, f)
	}
	return out, nil
}

// flatFields merges an object's own properties with those of every
// flattened alternative. A property the alternatives type differently is
// a string when every version is a string, raw JSON otherwise; it is
// required only when every alternative requires it.
func (b *builder) flatFields(n *node) ([]Field, error) {
	type prop struct {
		versions []*node
		required int
	}
	props := map[string]*prop{}
	for _, name := range sortedKeys(n.Properties) {
		props[name] = &prop{versions: []*node{n.Properties[name]}, required: len(n.AnyOf)}
		if !contains(n.Required, name) {
			props[name].required = 0
		}
	}
	for _, a := range n.AnyOf {
		ref, err := b.refName(a.Ref)
		if err != nil {
			return nil, err
		}
		if b.kinds[ref] != KindStruct {
			return nil, fmt.Errorf("flattened %s is not an object", ref)
		}
		alt := b.pool[ref].n
		for name, p := range alt.Properties {
			if _, own := n.Properties[name]; own {
				return nil, fmt.Errorf("flattened %s repeats property %s", ref, name)
			}
			if props[name] == nil {
				props[name] = &prop{}
			}
			props[name].versions = append(props[name].versions, p)
			if contains(alt.Required, name) {
				props[name].required++
			}
		}
	}
	var out []Field
	for _, name := range sortedKeys(props) {
		p := props[name]
		required := p.required == len(n.AnyOf)
		same := true
		for _, v := range p.versions[1:] {
			same = same && shape(v) == shape(p.versions[0])
		}
		if same {
			f, err := b.field(name, p.versions[0], required)
			if err != nil {
				return nil, fmt.Errorf("property %s: %w", name, err)
			}
			out = append(out, f)
			continue
		}
		goType := "string"
		for _, v := range p.versions {
			if !b.isStringish(v) {
				goType = "json.RawMessage"
			}
		}
		f := Field{GoName: goName(name), JSON: name, GoType: goType}
		if !required {
			f.Omit = "omitempty"
		}
		out = append(out, f)
	}
	return out, nil
}

func (b *builder) isStringish(n *node) bool {
	if n.Ref != "" {
		ref, err := b.refName(n.Ref)
		return err == nil && b.kinds[ref] == KindEnum
	}
	return n.isType("string")
}

// goType is a property's Go type before optionality is applied.
type goType struct {
	expr string
	// nullable: the schema allows null.
	nullable bool
	// nilable: the Go type has its own nil (slice, map, raw JSON).
	nilable bool
	// composite: a struct, union or other aggregate held by pointer when
	// optional.
	composite bool
}

var intFormats = map[string]string{
	"":       "int64",
	"int":    "int64",
	"int8":   "int8",
	"int16":  "int16",
	"int32":  "int32",
	"int64":  "int64",
	"uint":   "uint64",
	"uint8":  "uint8",
	"uint16": "uint16",
	"uint32": "uint32",
	"uint64": "uint64",
}

func (b *builder) typeOf(n *node) (goType, error) {
	if n.Any {
		return goType{expr: "json.RawMessage", nilable: true}, nil
	}
	if n.Const != nil || n.Enum != nil || n.OneOf != nil || n.Properties != nil {
		return goType{}, errors.New("inline enums, unions and objects are not supported; name them in $defs")
	}
	if n.Ref != "" {
		name, err := b.refName(n.Ref)
		if err != nil {
			return goType{}, err
		}
		switch b.kinds[name] {
		case KindEnum:
			return goType{expr: name}, nil
		case KindRaw:
			return goType{expr: name, nilable: true}, nil
		}
		return goType{expr: name, composite: true}, nil
	}
	if n.AnyOf != nil {
		if len(n.AnyOf) == 2 {
			for i, a := range n.AnyOf {
				if !a.Any && a.isType("null") && len(a.alternatives()) == 0 {
					t, err := b.typeOf(n.AnyOf[1-i])
					t.nullable = true
					return t, err
				}
			}
		}
		return goType{}, errors.New("an inline anyOf other than T|null is not supported")
	}
	var types []string
	nullable := false
	for _, t := range n.Type {
		if t == "null" {
			nullable = true
			continue
		}
		types = append(types, t)
	}
	if len(types) != 1 {
		return goType{}, fmt.Errorf("type %v is not one type, optionally with null", []string(n.Type))
	}
	out := goType{nullable: nullable}
	switch types[0] {
	case "string":
		if n.Format != "" {
			return goType{}, fmt.Errorf("string format %q is not supported", n.Format)
		}
		out.expr = "string"
	case "boolean":
		out.expr = "bool"
	case "integer":
		e, ok := intFormats[n.Format]
		if !ok {
			return goType{}, fmt.Errorf("integer format %q is not supported", n.Format)
		}
		out.expr = e
	case "number":
		if n.Format != "" && n.Format != "float" && n.Format != "double" {
			return goType{}, fmt.Errorf("number format %q is not supported", n.Format)
		}
		out.expr = "float64"
	case "array":
		if n.Items == nil {
			return goType{}, errors.New("an array needs items")
		}
		elem, err := b.typeOf(n.Items)
		if err != nil {
			return goType{}, fmt.Errorf("items: %w", err)
		}
		out.expr = "[]" + elem.held()
		out.nilable = true
	case "object":
		if n.AdditionalProperties == nil {
			return goType{}, errors.New("an inline object needs additionalProperties")
		}
		val, err := b.typeOf(n.AdditionalProperties)
		if err != nil {
			return goType{}, fmt.Errorf("additionalProperties: %w", err)
		}
		out.expr = "map[string]" + val.held()
		out.nilable = true
	default:
		return goType{}, fmt.Errorf("type %q is not supported", types[0])
	}
	return out, nil
}

// held is the Go type of an array element or map value: a pointer when
// the element may be null and has no nil of its own.
func (t goType) held() string {
	if t.nullable && !t.nilable {
		return "*" + t.expr
	}
	return t.expr
}

// zeroDefault reports whether a schema default is Go's zero value, so an
// absent field and the default decode the same.
func zeroDefault(def json.RawMessage) bool {
	switch string(bytes.TrimSpace(def)) {
	case "false", "0", `""`:
		return true
	}
	return false
}

// field maps one property to a struct field:
//
//   - a slice, map or raw JSON value is held as is (nil is absent or null)
//     with omitzero when optional, so an empty list still encodes as [];
//   - a nullable value is a pointer, omitted when nil if optional;
//   - a required value is held as is;
//   - an optional struct or union is a pointer, omitted when nil;
//   - an optional scalar or enum whose default is Go's zero value is held as
//     is with omitempty; any other optional scalar is a pointer, so absent
//     and zero stay distinct.
func (b *builder) field(name string, n *node, required bool) (Field, error) {
	t, err := b.typeOf(n)
	if err != nil {
		return Field{}, err
	}
	f := Field{GoName: goName(name), JSON: name, Doc: n.Description}
	switch {
	case t.nilable:
		f.GoType = t.expr
		if !required {
			f.Omit = "omitzero"
		}
	case t.nullable:
		f.GoType = "*" + t.expr
		if !required {
			f.Omit = "omitempty"
		}
	case required:
		f.GoType = t.expr
	case !t.composite && zeroDefault(n.Default):
		f.GoType = t.expr
		f.Omit = "omitempty"
	default:
		f.GoType = "*" + t.expr
		f.Omit = "omitempty"
	}
	if !goIdent.MatchString(f.GoName) {
		return Field{}, fmt.Errorf("property %q gives no Go identifier", name)
	}
	return f, nil
}

var goIdent = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)

// checkNames fails when two generated identifiers would collide.
func (m *Model) checkNames() error {
	owner := map[string]string{}
	claim := func(id, what string) error {
		if other, ok := owner[id]; ok {
			return fmt.Errorf("Go name %s is claimed by both %s and %s", id, other, what)
		}
		owner[id] = what
		return nil
	}
	for _, name := range sortedKeys(m.Types) {
		if err := claim(name, "type "+name); err != nil {
			return err
		}
	}
	for _, name := range sortedKeys(m.Types) {
		t := m.Types[name]
		for _, v := range t.Values {
			if err := claim(v.GoName, fmt.Sprintf("%s value %q", name, v.Value)); err != nil {
				return err
			}
		}
		for _, v := range t.Variants {
			if err := claim(v.GoName, fmt.Sprintf("%s variant %q", name, v.Tag)); err != nil {
				return err
			}
		}
		if t.Kind == KindUnion {
			if err := claim(name+"Variant", name+"'s variant interface"); err != nil {
				return err
			}
		}
	}
	for _, id := range reservedNames {
		if what, ok := owner[id]; ok {
			return fmt.Errorf("%s collides with the hand-written %s", what, id)
		}
	}
	return nil
}

// reservedNames are declared by hand in package herdrapi.
var reservedNames = []string{"UnknownVariant", "Protocol", "SchemaVersion"}

var initialisms = map[string]string{
	"api": "API", "cpu": "CPU", "http": "HTTP", "https": "HTTPS", "id": "ID", "ids": "IDs",
	"ip": "IP", "json": "JSON", "os": "OS", "pid": "PID", "pty": "PTY", "sha256": "SHA256", "ssh": "SSH",
	"tcp": "TCP", "tls": "TLS", "tty": "TTY", "ui": "UI", "uri": "URI", "url": "URL", "urls": "URLs",
}

var wordSplit = regexp.MustCompile(`[^A-Za-z0-9]+`)

// camel turns snake_case, dotted or dashed text into an exported Go name.
func camel(s string) string {
	var out strings.Builder
	for _, w := range wordSplit.Split(s, -1) {
		if w == "" {
			continue
		}
		if up, ok := initialisms[strings.ToLower(w)]; ok {
			out.WriteString(up)
			continue
		}
		out.WriteString(strings.ToUpper(w[:1]) + w[1:])
	}
	return out.String()
}

// goName is a struct field's name; a property that starts with a digit
// gets an "F" prefix.
func goName(json string) string {
	n := camel(json)
	if n != "" && n[0] >= '0' && n[0] <= '9' {
		n = "F" + n
	}
	return n
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
