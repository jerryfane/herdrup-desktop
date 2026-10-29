package apigen

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/fixture_gen.go.golden")

const pin = "0123456789abcdef0123456789abcdef01234567"

func fixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "fixture.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestGoldenFixture pins the generator's output for a schema with every
// shape it maps: a struct per object, optional fields of each kind, an enum
// from "enum" and one from oneOf consts, a tagged union, an untagged union,
// the request envelope, and a type defined in two sections.
func TestGoldenFixture(t *testing.T) {
	got, err := GenerateGo(fixture(t), pin)
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "fixture_gen.go.golden")
	if *update {
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("generated Go differs from %s (go test ./internal/apigen -update to accept):\n%s", golden, got)
	}
	for _, line := range []string{
		Header(pin),
		"Protocol      = 7",
		"SchemaVersion = 3",
		// Optional: a nullable scalar is a pointer, a false-default bool
		// and a zero-default enum are plain with omitempty, a list uses
		// omitzero, a struct is a pointer, a required field has no option.
		"Limit     *uint32  `json:\"limit,omitempty\"`",
		"LocalOnly bool     `json:\"local_only,omitempty\"`",
		"Tags      []string `json:\"tags,omitzero\"`",
		"Target    string   `json:\"target\"`",
		"Wait      *Wait    `json:\"wait,omitempty\"`",
		"Labels map[string]string `json:\"labels,omitzero\"`",
		"Mode   *Mode             `json:\"mode,omitempty\"`",
		"Extra  json.RawMessage   `json:\"extra\"`",
		// Enums.
		"ColorLightBlue Color = \"light_blue\"",
		"ModeLater Mode = \"later\"",
		// The tagged union's variants, minus the tag.
		"type ResponseResultThing struct {",
		"func (ResponseResultOk) variantTag() string { return \"ok\" }",
		"type Size = json.RawMessage",
		"case \"thing.get\":",
	} {
		if !bytes.Contains(got, []byte(line)) {
			t.Errorf("generated Go lacks %q", line)
		}
	}
	// Color is defined in both sections and emitted once.
	if n := bytes.Count(got, []byte("type Color string")); n != 1 {
		t.Errorf("Color emitted %d times", n)
	}
}

func TestSameNamedDefinitionsMustAgree(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(fixture(t), &doc); err != nil {
		t.Fatal(err)
	}
	color := doc["schemas"].(map[string]any)["success_response"].(map[string]any)["$defs"].(map[string]any)["Color"].(map[string]any)
	color["enum"] = []any{"red", "green"}
	raw, _ := json.Marshal(doc)
	_, err := Load(raw)
	if err == nil || !strings.Contains(err.Error(), "Color is defined differently in sections request and success_response") {
		t.Fatalf("conflicting Color: %v", err)
	}
}

func TestLoadRejectsWhatItCannotMap(t *testing.T) {
	for name, edit := range map[string]func(defs map[string]any){
		"unknown keyword": func(defs map[string]any) {
			defs["Wait"].(map[string]any)["if"] = map[string]any{}
		},
		"inline enum": func(defs map[string]any) {
			defs["Wait"].(map[string]any)["properties"].(map[string]any)["unit"] = map[string]any{"enum": []any{"s"}, "type": "string"}
		},
		"unresolved ref": func(defs map[string]any) {
			defs["Wait"].(map[string]any)["properties"].(map[string]any)["next"] = map[string]any{"$ref": "#/schemas/request/$defs/Nope"}
		},
	} {
		var doc map[string]any
		if err := json.Unmarshal(fixture(t), &doc); err != nil {
			t.Fatal(err)
		}
		edit(doc["schemas"].(map[string]any)["request"].(map[string]any)["$defs"].(map[string]any))
		raw, _ := json.Marshal(doc)
		if _, err := Load(raw); err == nil {
			t.Errorf("%s: loaded", name)
		}
	}
}

// TestGeneratedFixtureDecodes compiles the fixture's generated Go with
// herdrapi's hand-written union helpers and round-trips JSON through it.
func TestGeneratedFixtureDecodes(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a module")
	}
	goSrc, err := GenerateGo(fixture(t), pin)
	if err != nil {
		t.Fatal(err)
	}
	union, err := os.ReadFile(filepath.Join("..", "herdrapi", "union.go"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	files := map[string]string{
		"go.mod":       "module fixture\n\ngo 1.24\n",
		"types_gen.go": string(goSrc),
		"union.go":     string(union),
		"fixture_test.go": `package herdrapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestDecode(t *testing.T) {
	var r SuccessResponse
	line := ` + "`" + `{"id":"1","result":{"type":"thing","color":"light_blue","extra":[1],"labels":{"a":"b"},"mode":"later","added_later":true},"size":"50%"}` + "`" + `
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatal(err)
	}
	thing, ok := r.Result.Value.(ResponseResultThing)
	if !ok || thing.Color != ColorLightBlue || string(thing.Extra) != "[1]" || thing.Labels["a"] != "b" || thing.Mode == nil || *thing.Mode != ModeLater || string(r.Size) != ` + "`" + `"50%"` + "`" + ` {
		t.Fatalf("decoded %#v", r)
	}
	if !thing.Color.Known() || Color("blue").Known() {
		t.Fatal("Known")
	}
	out, _ := json.Marshal(r)
	if want := ` + "`" + `{"id":"1","result":{"type":"thing","color":"light_blue","extra":[1],"labels":{"a":"b"},"mode":"later"},"size":"50%"}` + "`" + `; string(out) != want {
		t.Fatalf("encoded %s", out)
	}
	if err := json.Unmarshal([]byte(` + "`" + `{"type":"pong","version":"1"}` + "`" + `), &r.Result); err != nil || r.Result.Value != (ResponseResultPong{Version: "1"}) {
		t.Fatalf("pong %#v %v", r.Result.Value, err)
	}
	if err := json.Unmarshal([]byte(` + "`" + `{"type":"new","a":1}` + "`" + `), &r.Result); err != nil || r.Result.Tag() != "new" {
		t.Fatalf("unknown %#v %v", r.Result.Value, err)
	}

	var req Request
	if err := json.Unmarshal([]byte(` + "`" + `{"id":"2","method":"thing.get","params":{"target":"t","wait":{"seconds":3}}}` + "`" + `), &req); err != nil {
		t.Fatal(err)
	}
	p, ok := req.Params.(GetParams)
	if !ok || p.Target != "t" || p.Wait == nil || p.Wait.Seconds != 3 || p.Limit != nil {
		t.Fatalf("params %#v", req.Params)
	}
	out, _ = json.Marshal(GetParams{Target: "t", Tags: []string{}})
	if string(out) != ` + "`" + `{"tags":[],"target":"t"}` + "`" + ` {
		t.Fatalf("params encoded %s", out)
	}
	if reflect.TypeOf(PingParams{}).NumField() != 0 {
		t.Fatal("PingParams has fields")
	}
}
`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "test", "./...")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOWORK=off", "GOFLAGS=-mod=mod", "GOTOOLCHAIN=local")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generated fixture does not decode: %v\n%s", err, out)
	}
}

// fakeHerdr serves the schema of one commit.
type fakeHerdr struct {
	commit string
	schema []byte
}

func (f fakeHerdr) Fetch(_ context.Context, commit, path string) ([]byte, error) {
	if commit != f.commit || path != SchemaSource {
		return nil, fmt.Errorf("404 %s at %s", path, commit)
	}
	return f.schema, nil
}

func pinned(t *testing.T) (string, fakeHerdr) {
	t.Helper()
	root := t.TempDir()
	fetch := fakeHerdr{pin, fixture(t)}
	if err := Pin(context.Background(), root, pin, fetch); err != nil {
		t.Fatal(err)
	}
	return root, fetch
}

func TestPinWritesACheckedCopy(t *testing.T) {
	root, fetch := pinned(t)
	prov, err := ReadProvenance(root)
	if err != nil {
		t.Fatal(err)
	}
	if prov.Commit != pin || prov.SHA256 != sum(fixture(t)) || prov.Protocol != 7 || prov.SchemaVersion != 3 {
		t.Fatalf("provenance %+v", prov)
	}
	copied, _ := readFile(root, SchemaCopy)
	if !bytes.Equal(copied, fixture(t)) {
		t.Fatal("the pinned copy is not byte for byte the fetched schema")
	}
	if errs := Check(root); len(errs) != 0 {
		t.Fatalf("check after pinning: %v", errs)
	}
	if errs := VerifyUpstream(context.Background(), root, fetch); len(errs) != 0 {
		t.Fatalf("upstream check after pinning: %v", errs)
	}
	before, _ := readFile(root, GoPath)
	if err := Generate(root); err != nil {
		t.Fatal(err)
	}
	if after, _ := readFile(root, GoPath); !bytes.Equal(before, after) {
		t.Fatal("regenerating changed the generated file")
	}
}

func TestPinRefusesAShortCommitAndABadSchema(t *testing.T) {
	if err := Pin(context.Background(), t.TempDir(), "main", nil); err == nil {
		t.Fatal("pinned a branch name")
	}
	root := t.TempDir()
	if err := Pin(context.Background(), root, pin, fakeHerdr{pin, []byte(`{"protocol":1}`)}); err == nil {
		t.Fatal("pinned a schema with no sections")
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(ProvenancePath))); !os.IsNotExist(err) {
		t.Fatalf("a failed pin wrote %s: %v", ProvenancePath, err)
	}
}

func edit(t *testing.T, root, rel, from, to string) {
	t.Helper()
	data, err := readFile(root, rel)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(from)) {
		t.Fatalf("%s lacks %q", rel, from)
	}
	if err := writeFile(root, rel, bytes.Replace(data, []byte(from), []byte(to), 1)); err != nil {
		t.Fatal(err)
	}
}

func wantErr(t *testing.T, errs []error, part string) {
	t.Helper()
	for _, err := range errs {
		if strings.Contains(err.Error(), part) {
			return
		}
	}
	t.Fatalf("want an error containing %q, have %v", part, errs)
}

func TestCheckFindsAnEditedSchema(t *testing.T) {
	root, fetch := pinned(t)
	// The second section's Color description is dropped by the
	// de-duplication, so editing it changes the hash but not the Go.
	edit(t, root, SchemaCopy, "described differently", "described otherwise")
	errs := Check(root)
	wantErr(t, errs, SchemaCopy+" differs from")
	if len(errs) != 1 {
		t.Fatalf("errors %v", errs)
	}
	wantErr(t, VerifyUpstream(context.Background(), root, fetch), SchemaCopy+" is not")
}

func TestCheckFindsAnEditedGeneratedFile(t *testing.T) {
	root, _ := pinned(t)
	edit(t, root, GoPath, "ColorLightBlue Color = \"light_blue\"", "ColorLightBlue Color = \"blue\"")
	errs := Check(root)
	wantErr(t, errs, GoPath+" is stale or edited")
	if len(errs) != 1 {
		t.Fatalf("errors %v", errs)
	}
}

func TestCheckFindsAStaleProvenance(t *testing.T) {
	root, _ := pinned(t)
	edit(t, root, ProvenancePath, `"protocol": 7`, `"protocol": 6`)
	wantErr(t, Check(root), "records protocol 6")
}

func TestVerifyUpstreamCatchesARewrittenRecord(t *testing.T) {
	root, _ := pinned(t)
	// The copy and its hash moved together, so the offline check passes,
	// but herdr at the pin has something else.
	edit(t, root, SchemaCopy, "described differently", "described otherwise")
	copied, _ := readFile(root, SchemaCopy)
	edit(t, root, ProvenancePath, sum(fixture(t)), sum(copied))
	if errs := Check(root); len(errs) != 0 {
		t.Fatalf("offline check: %v", errs)
	}
	errs := VerifyUpstream(context.Background(), root, fakeHerdr{pin, fixture(t)})
	wantErr(t, errs, "but "+ProvenancePath+" records")
	wantErr(t, errs, SchemaCopy+" is not")
}

// TestRepoPinIsCurrent is -check on this repository: the pinned schema
// matches its record and internal/herdrapi/types_gen.go is what it
// generates.
func TestRepoPinIsCurrent(t *testing.T) {
	for _, err := range Check(filepath.Join("..", "..")) {
		t.Error(err)
	}
}
