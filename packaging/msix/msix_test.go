package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// The Store takes four numbers, the first not 0 and the last 0, and serves
// the highest: every release, previews included, must map above the last.
func TestMSIXVersion(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"0.1.0-preview.23", "1.1.23.0"},
		{"0.1.0-preview.1", "1.1.1.0"},
		{"0.1.0", "1.1.999.0"},
		{"0.1.1-preview.2", "1.1.1002.0"},
		{"0.2.0-preview.998", "1.2.998.0"},
		{"1.0.0", "2.0.999.0"},
		{"1.4.64", "2.4.64999.0"},
	} {
		got, err := msixVersion(c.in)
		if err != nil || got != c.want {
			t.Errorf("msixVersion(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	for _, bad := range []string{"0.1", "0.1.0-beta.1", "0.1.0-preview", "v0.1.0", "0.1.0-preview.999", "0.1.65", "0.65536.0", "65535.0.0",
		// Past 65535 only after the arithmetic wrapped: rejected before it.
		"0.1.18446744073709552", "0.1.9223372036854776", "18446744073709551615.0.0", "0.1.0-preview.18446744073709551615", "0.1.99999999999999999999"} {
		if got, err := msixVersion(bad); err == nil {
			t.Errorf("msixVersion(%q) = %q, want an error", bad, got)
		}
	}
	// In semver's order, each maps higher than the one before.
	order := []string{"0.1.0-preview.9", "0.1.0-preview.10", "0.1.0-preview.23", "0.1.0", "0.1.1-preview.1", "0.1.1", "0.2.0-preview.1", "0.2.0", "1.0.0-preview.1", "1.0.0"}
	var last []int
	for _, v := range order {
		m, err := msixVersion(v)
		if err != nil {
			t.Fatal(err)
		}
		n, ok := sdkVersion(m)
		if !ok || n[0] == 0 || n[3] != 0 {
			t.Fatalf("%s -> %s: not a Store version", v, m)
		}
		if last != nil && !versionLess(last, n) {
			t.Errorf("%s -> %s is not above %v", v, m, last)
		}
		last = n
	}
}

func TestPackageVersionIsTheRepositorys(t *testing.T) {
	v, err := packageVersion("../../package.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := msixVersion(v); err != nil {
		t.Fatalf("package.json's version has no package version: %v", err)
	}
}

// manifestDoc is the part of AppxManifest.xml the tests read.
type manifestDoc struct {
	Identity struct {
		Name, Publisher, Version, ProcessorArchitecture string `xml:",attr"`
	}
	Properties struct {
		DisplayName, PublisherDisplayName, Logo string
	}
	Dependencies struct {
		TargetDeviceFamily struct {
			Name, MinVersion, MaxVersionTested string `xml:",attr"`
		}
	}
	Resources struct {
		Resource []struct {
			Language string `xml:",attr"`
		}
	}
	Applications struct {
		Application []struct {
			Id, Executable, EntryPoint string `xml:",attr"`
			VisualElements             struct {
				DisplayName, Description, BackgroundColor, Square150x150Logo, Square44x44Logo string `xml:",attr"`
				DefaultTile                                                                   struct {
					Wide310x150Logo string `xml:",attr"`
				}
			}
			Extensions struct {
				Extension []struct {
					Category string `xml:",attr"`
					Protocol struct {
						Name, Parameters string `xml:",attr"`
					}
				}
			}
		}
	}
}

// wellFormed reads every token of an XML document.
func wellFormed(b []byte) error {
	d := xml.NewDecoder(bytes.NewReader(b))
	for {
		_, err := d.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func TestManifest(t *testing.T) {
	if err := wellFormed([]byte(manifestTemplate)); err != nil {
		t.Fatalf("the template is not XML: %v", err)
	}
	id := identity{Name: "HerdrupCI", Publisher: `CN=Jerry & "Co", O=<x>`, PublisherDisplayName: "Herdrup & co", Version: "1.1.23.0"}
	b, err := manifest(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := wellFormed(b); err != nil {
		t.Fatalf("manifest is not XML: %v\n%s", err, b)
	}
	var m manifestDoc
	if err := xml.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if got := m.Identity; got.Name != id.Name || got.Publisher != id.Publisher || got.Version != id.Version || got.ProcessorArchitecture != "x64" {
		t.Errorf("Identity: %+v", got)
	}
	if got := m.Properties; got.DisplayName != "herdrup" || got.PublisherDisplayName != id.PublisherDisplayName || got.Logo != `Assets\StoreLogo.png` {
		t.Errorf("Properties: %+v", got)
	}
	if got := m.Dependencies.TargetDeviceFamily; got.Name != "Windows.Desktop" || got.MinVersion != "10.0.22000.0" || got.MaxVersionTested == "" {
		t.Errorf("TargetDeviceFamily: %+v", got)
	}
	if len(m.Resources.Resource) != 1 || m.Resources.Resource[0].Language != "en-us" {
		t.Errorf("Resources: %+v", m.Resources)
	}
	if len(m.Applications.Application) != 1 {
		t.Fatalf("Applications: %+v", m.Applications)
	}
	app := m.Applications.Application[0]
	if app.Id != "App" || app.Executable != "herdrup.exe" || app.EntryPoint != "Windows.FullTrustApplication" {
		t.Errorf("Application: %+v", app)
	}
	v := app.VisualElements
	if v.DisplayName == "" || v.Description == "" || v.BackgroundColor != "transparent" {
		t.Errorf("VisualElements: %+v", v)
	}
	// Every image named is one of the logos made, and every logo is named.
	named := []string{m.Properties.Logo, v.Square44x44Logo, v.Square150x150Logo, v.DefaultTile.Wide310x150Logo}
	var made []string
	for _, l := range logos {
		made = append(made, `Assets\`+l.name)
	}
	slices.Sort(named)
	slices.Sort(made)
	if !slices.Equal(named, made) {
		t.Errorf("images named %v, made %v", named, made)
	}
	if e := app.Extensions.Extension; len(e) != 1 || e[0].Category != "windows.protocol" || e[0].Protocol.Name != "herdrup" || e[0].Protocol.Parameters != `"%1"` {
		t.Errorf("Extensions: %+v", e)
	}
	// Capability elements, then DeviceCapability ones, as the schema orders them.
	var caps []string
	d := xml.NewDecoder(bytes.NewReader(b))
	in := false
	for {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch e := tok.(type) {
		case xml.StartElement:
			if e.Name.Local == "Capabilities" {
				in = true
			} else if in {
				name := ""
				for _, a := range e.Attr {
					if a.Name.Local == "Name" {
						name = a.Value
					}
				}
				prefix := ""
				if strings.HasSuffix(e.Name.Space, "/restrictedcapabilities") {
					prefix = "rescap:"
				}
				caps = append(caps, prefix+e.Name.Local+"="+name)
			}
		case xml.EndElement:
			if e.Name.Local == "Capabilities" {
				in = false
			}
		}
	}
	want := []string{"rescap:Capability=runFullTrust", "DeviceCapability=microphone", "DeviceCapability=webcam"}
	if !slices.Equal(caps, want) {
		t.Errorf("Capabilities %v, want %v", caps, want)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

const (
	testIcon   = "../../resources/icon.png"
	testSpeech = "../../" + speechList
)

// testPayload is the repository's payload.
func testPayload(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(testSpeech)
	if err != nil {
		t.Fatal(err)
	}
	p, err := parsePayload(b)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// testSources reads the build in from, the repository's icon and lists.
func testSources(t *testing.T, from string) sources {
	return sources{from: from, payload: testPayload(t), icon: testIcon}
}

// buildDir writes a Windows build: the payload, and what else mygo writes
// next to it.
func buildDir(t *testing.T, dir string) {
	t.Helper()
	for _, f := range testPayload(t) {
		writeFile(t, filepath.Join(dir, f), "app "+f)
	}
	for _, f := range []string{"herdrup-setup-0.1.0-preview.23-amd64.exe", "install.ps1", "herdrup-0.1.0-preview.23-windows-amd64.tar.gz", "update-windows-amd64.json", "icon.png", "extra/data.txt"} {
		writeFile(t, filepath.Join(dir, f), "other "+f)
	}
}

// files lists the files in dir, relative to it, sorted.
func files(t *testing.T, dir string) []string {
	t.Helper()
	var got []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			got = append(got, filepath.ToSlash(rel))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(got)
	return got
}

var ciIdentity = identity{Name: "HerdrupCI", Publisher: "CN=HerdrupCI", PublisherDisplayName: "HerdrupCI", Version: "1.1.23.0"}

// The payload is herdrup.exe and the speech resources mygo.config.ts ships,
// from the one list, speech/resources.json; a list naming anything but a
// file of the build's folder is refused.
func TestParsePayload(t *testing.T) {
	want := []string{"herdrup.exe", "herdrup-speech.exe", "ggml-tiny.bin", "whisper-LICENSE", "speech-LICENSES"}
	if got := testPayload(t); !slices.Equal(got, want) {
		t.Errorf("payload %v, want %v", got, want)
	}
	got, err := parsePayload([]byte(`{"helper": "h", "files": ["a", "b.bin"]}`))
	if want := []string{"herdrup.exe", "h.exe", "a", "b.bin"}; err != nil || !slices.Equal(got, want) {
		t.Errorf("another list: %v, %v; want %v", got, err, want)
	}
	for _, bad := range []string{
		`{"files": ["a"]}`,
		`{"helper": "h"}`,
		`{"helper": "h", "files": ["../a"]}`,
		`{"helper": "h", "files": ["d/a"]}`,
		`{"helper": "h", "files": ["d\\a"]}`,
		`{"helper": "h", "files": ["C:a"]}`,
		`{"helper": "h", "files": [".."]}`,
		`{"helper": "../h", "files": ["a"]}`,
		`not json`,
	} {
		if got, err := parsePayload([]byte(bad)); err == nil {
			t.Errorf("parsePayload(%s) = %v, want an error", bad, got)
		}
	}
}

// The package holds the payload, the logos and the manifest, and nothing
// else of the build: not mygo's installer, update files or install script.
func TestStage(t *testing.T) {
	from, dir := t.TempDir(), filepath.Join(t.TempDir(), "stage")
	buildDir(t, from)
	got, err := stage(testSources(t, from), dir, ciIdentity)
	if err != nil {
		t.Fatal(err)
	}
	want := append(testPayload(t), "AppxManifest.xml")
	for _, l := range logos {
		want = append(want, "Assets/"+l.name)
	}
	slices.Sort(want)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("stage lists %v\nwant %v", got, want)
	}
	if onDisk := files(t, dir); !slices.Equal(onDisk, want) {
		t.Fatalf("staged %v\nwant %v", onDisk, want)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "herdrup-speech.exe")); string(b) != "app herdrup-speech.exe" {
		t.Errorf("herdrup-speech.exe holds %q", b)
	}
	for _, l := range logos {
		f, err := os.Open(filepath.Join(dir, "Assets", l.name))
		if err != nil {
			t.Fatal(err)
		}
		c, err := png.DecodeConfig(f)
		f.Close()
		if err != nil || c.Width != l.w || c.Height != l.h {
			t.Errorf("%s: %dx%d (%v), want %dx%d", l.name, c.Width, c.Height, err, l.w, l.h)
		}
	}
	m, _ := os.ReadFile(filepath.Join(dir, "AppxManifest.xml"))
	if !bytes.Contains(m, []byte(`Name="HerdrupCI" Publisher="CN=HerdrupCI" Version="1.1.23.0" ProcessorArchitecture="x64"`)) {
		t.Errorf("manifest identity:\n%s", m)
	}
	// An empty folder is taken too.
	if _, err := stage(testSources(t, from), t.TempDir(), ciIdentity); err != nil {
		t.Errorf("empty folder: %v", err)
	}
}

// A build without the whole payload (the speech resources not built
// first) is not packaged, and nothing is written.
func TestStageNeedsTheWholePayload(t *testing.T) {
	for _, missing := range testPayload(t) {
		from, dir := t.TempDir(), filepath.Join(t.TempDir(), "stage")
		buildDir(t, from)
		if err := os.Remove(filepath.Join(from, missing)); err != nil {
			t.Fatal(err)
		}
		if _, err := stage(testSources(t, from), dir, ciIdentity); err == nil || !strings.Contains(err.Error(), missing) {
			t.Errorf("without %s: %v", missing, err)
		}
		if fileExists(dir) {
			t.Errorf("without %s: wrote %s", missing, dir)
		}
	}
}

// The packer deletes and replaces nothing: a staging folder that is not new
// or empty, its own last stage included, is refused and left as it was.
func TestStageNeedsANewOrEmptyFolder(t *testing.T) {
	from := t.TempDir()
	buildDir(t, from)
	for name, setup := range map[string]func(dir string){
		"the last stage": func(dir string) {
			if err := os.Remove(dir); err != nil {
				t.Fatal(err)
			}
			if _, err := stage(testSources(t, from), dir, ciIdentity); err != nil {
				t.Fatal(err)
			}
		},
		"a hidden file": func(dir string) { writeFile(t, filepath.Join(dir, ".notes"), "someone's") },
		"a folder":      func(dir string) { writeFile(t, filepath.Join(dir, "sub", "notes.txt"), "someone's") },
	} {
		dir := t.TempDir()
		setup(dir)
		before := files(t, dir)
		if _, err := stage(testSources(t, from), dir, ciIdentity); err == nil || !strings.Contains(err.Error(), "must be new or empty") {
			t.Errorf("%s: %v", name, err)
		}
		if after := files(t, dir); !slices.Equal(after, before) {
			t.Errorf("%s: the folder now holds %v\nwas %v", name, after, before)
		}
	}
	file := filepath.Join(t.TempDir(), "file")
	writeFile(t, file, "a file")
	if _, err := stage(testSources(t, from), file, ciIdentity); err == nil {
		t.Error("staged into a file")
	}
	if b, _ := os.ReadFile(file); string(b) != "a file" {
		t.Errorf("the file holds %q", b)
	}
}

// A folder that can't be listed can't be shown empty: it is refused, even
// where it could be written to, and its files are left as they were.
func TestStageRefusesAnUnlistableFolder(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a folder this user may write to but not list")
	}
	from := t.TempDir()
	buildDir(t, from)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, appExe), "someone's")
	if err := os.Chmod(dir, 0o300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := stage(testSources(t, from), dir, ciIdentity); err == nil {
		t.Error("staged into a folder it can't list")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, appExe)); string(b) != "someone's" {
		t.Errorf("%s holds %q", appExe, b)
	}
}

// pack overwrites no package: an -out that exists is refused before
// anything is staged. Without -out, pack only stages.
func TestPackRefusesAnExistingOutput(t *testing.T) {
	from := t.TempDir()
	buildDir(t, from)
	abs := func(p string) string {
		a, err := filepath.Abs(p)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	icon, pkg := abs(testIcon), abs("../../package.json")
	args := func(stage string) []string {
		return []string{"pack", "-from", from, "-stage", stage, "-icon", icon, "-package", pkg,
			"-name", "HerdrupCI", "-publisher", "CN=HerdrupCI", "-publisher-display-name", "HerdrupCI"}
	}
	list, err := os.ReadFile(testSpeech)
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	writeFile(t, speechList, string(list))
	if err := run(args("stage")); err != nil {
		t.Fatalf("pack without -out: %v", err)
	}
	writeFile(t, "herdrup.msix", "the last package")
	err = run(append(args("stage2"), "-out", "herdrup.msix"))
	if err == nil || !strings.Contains(err.Error(), "exists") {
		t.Errorf("an existing -out: %v", err)
	}
	if b, _ := os.ReadFile("herdrup.msix"); string(b) != "the last package" || fileExists("stage2") {
		t.Errorf("an existing -out: it holds %q; staged: %v", b, fileExists("stage2"))
	}
}

// Every part of the identity is required, the publisher display name too:
// the Store's must be the one Partner Center reserved.
func TestStageRefusesIdentity(t *testing.T) {
	from := t.TempDir()
	buildDir(t, from)
	good := identity{Name: "Jerry.Herdrup", Publisher: "CN=0A1B2C3D-0000-0000-0000-000000000000", PublisherDisplayName: "Jerry Fane", Version: "1.1.23.0"}
	for _, id := range []identity{
		{Name: "", Publisher: good.Publisher, PublisherDisplayName: good.PublisherDisplayName},
		{Name: "Jerry Herdrup", Publisher: good.Publisher, PublisherDisplayName: good.PublisherDisplayName},
		{Name: "Jerry_Herdrup", Publisher: good.Publisher, PublisherDisplayName: good.PublisherDisplayName},
		{Name: good.Name, Publisher: "", PublisherDisplayName: good.PublisherDisplayName},
		{Name: good.Name, Publisher: "Jerry Fane", PublisherDisplayName: good.PublisherDisplayName},
		{Name: good.Name, Publisher: good.Publisher, PublisherDisplayName: ""},
		{Name: good.Name, Publisher: good.Publisher, PublisherDisplayName: "  "},
	} {
		id.Version = good.Version
		dir := filepath.Join(t.TempDir(), "s")
		if _, err := stage(testSources(t, from), dir, id); err == nil {
			t.Errorf("staged identity %+v", id)
		}
		if fileExists(dir) {
			t.Errorf("identity %+v: wrote %s", id, dir)
		}
	}
	if _, err := stage(testSources(t, from), filepath.Join(t.TempDir(), "s"), good); err != nil {
		t.Errorf("Partner Center's identity: %v", err)
	}
}

// makeappx packs the files stage listed, under their names in the package,
// and nothing else.
func TestMapping(t *testing.T) {
	dir := t.TempDir()
	got, err := mapping(dir, []string{"herdrup.exe", "Assets/StoreLogo.png"})
	if err != nil {
		t.Fatal(err)
	}
	want := "[Files]\r\n" +
		`"` + filepath.Join(dir, "herdrup.exe") + `" "herdrup.exe"` + "\r\n" +
		`"` + filepath.Join(dir, "Assets", "StoreLogo.png") + `" "Assets\StoreLogo.png"` + "\r\n"
	if got != want {
		t.Errorf("mapping:\n%s\nwant\n%s", got, want)
	}
}

func TestScaledAverages(t *testing.T) {
	// Black on the left, white on the right, then half transparent.
	src := image.NewNRGBA(image.Rect(0, 0, 4, 2))
	for x := range 4 {
		c := color.NRGBA{0, 0, 0, 255}
		if x >= 2 {
			c = color.NRGBA{255, 255, 255, 255}
		}
		src.SetNRGBA(x, 0, c)
		src.SetNRGBA(x, 1, color.NRGBA{255, 0, 0, 0})
	}
	if got := scaled(src, 2, 2); got.RGBAAt(0, 0) != (color.RGBA{0, 0, 0, 255}) || got.RGBAAt(1, 0) != (color.RGBA{255, 255, 255, 255}) || got.RGBAAt(0, 1).A != 0 {
		t.Errorf("2x2: %v %v %v", got.RGBAAt(0, 0), got.RGBAAt(1, 0), got.RGBAAt(0, 1))
	}
	// One pixel: the mean, with the transparent half counting for no colour.
	if got := scaled(src, 1, 1).RGBAAt(0, 0); got != (color.RGBA{64, 64, 64, 128}) {
		t.Errorf("1x1: %v, want {64 64 64 128}", got)
	}
	// A scale that is not a whole number: 3 to 2 pixels.
	row := image.NewGray(image.Rect(0, 0, 3, 1))
	row.Pix = []uint8{0, 90, 180}
	got := scaled(row, 2, 1)
	// (0 + 90/2)/1.5 = 30, (90/2 + 180)/1.5 = 150.
	if a, b := got.RGBAAt(0, 0).R, got.RGBAAt(1, 0).R; a != 30 || b != 150 {
		t.Errorf("3 to 2: %d %d, want 30 150", a, b)
	}
}

func TestNewestSDKTool(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{
		"bin/10.0.9600.0/x64/makeappx.exe",
		"bin/10.0.22621.0/x64/makeappx.exe",
		"bin/10.0.22621.0/x86/signtool.exe",
		"bin/10.0.26100.0/x64/signtool.exe", // the newest, without makeappx
		"bin/x64/oldtool.exe",
	} {
		writeFile(t, filepath.Join(root, p), "")
	}
	if err := os.MkdirAll(filepath.Join(root, "bin", "10.0.99999.0", "x64"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ exe, arch, want string }{
		{"makeappx.exe", "x64", "bin/10.0.22621.0/x64/makeappx.exe"},
		{"signtool.exe", "x64", "bin/10.0.26100.0/x64/signtool.exe"},
		{"signtool.exe", "x86", "bin/10.0.22621.0/x86/signtool.exe"},
		{"oldtool.exe", "x64", "bin/x64/oldtool.exe"},
		{"makepri.exe", "x64", ""},
	} {
		want := ""
		if c.want != "" {
			want = filepath.Join(root, filepath.FromSlash(c.want))
		}
		if got := newestSDKTool(root, c.exe, c.arch); got != want {
			t.Errorf("newestSDKTool(%s, %s) = %q, want %q", c.exe, c.arch, got, want)
		}
	}
}

func TestRegValue(t *testing.T) {
	out := "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows Kits\\Installed Roots\r\n    KitsRoot10    REG_SZ    C:\\Program Files (x86)\\Windows Kits\\10\\\r\n\r\n"
	if got := regValue(out, "KitsRoot10"); got != `C:\Program Files (x86)\Windows Kits\10\` {
		t.Errorf("KitsRoot10 = %q", got)
	}
	if got := regValue(out, "KitsRoot81"); got != "" {
		t.Errorf("KitsRoot81 = %q", got)
	}
}
