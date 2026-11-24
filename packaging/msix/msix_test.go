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
	for _, bad := range []string{"0.1", "0.1.0-beta.1", "0.1.0-preview", "v0.1.0", "0.1.0-preview.999", "0.1.65", "0.65536.0", "65535.0.0"} {
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
	id := identity{Name: "HerdrupCI", Publisher: `CN=Jerry & "Co", O=<x>`, PublisherDisplayName: "Herdrup & co", Version: "1.1.23.0", Arch: "x64"}
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
	if got := m.Dependencies.TargetDeviceFamily; got.Name != "Windows.Desktop" || got.MinVersion != "10.0.17763.0" || got.MaxVersionTested == "" {
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

// The package holds what the installer installs: the app and the speech
// engine's files, not mygo's installer, update files or install script.
func TestStage(t *testing.T) {
	from, dir := t.TempDir(), filepath.Join(t.TempDir(), "stage")
	app := []string{"herdrup.exe", "herdrup-speech.exe", "ggml-tiny.bin", "whisper-LICENSE", "speech-LICENSES", "extra/data.txt"}
	for _, f := range app {
		writeFile(t, filepath.Join(from, f), "app "+f)
	}
	for _, f := range []string{"herdrup-setup-0.1.0-preview.23-amd64.exe", "install.ps1", "herdrup-0.1.0-preview.23-windows-amd64.tar.gz", "herdrup-0.1.0-preview.22-windows-amd64.delta", "update-windows-amd64.json"} {
		writeFile(t, filepath.Join(from, f), "mygo "+f)
	}
	writeFile(t, filepath.Join(dir, "stale.txt"), "from the last run")
	id := identity{Name: "HerdrupCI", Publisher: "CN=HerdrupCI", PublisherDisplayName: "Herdrup", Version: "1.1.23.0", Arch: "x64"}
	if err := stage(from, dir, "../../resources/icon.png", id); err != nil {
		t.Fatal(err)
	}
	var got []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			got = append(got, filepath.ToSlash(rel))
		}
		return err
	})
	want := append(slices.Clone(app), "AppxManifest.xml")
	for _, l := range logos {
		want = append(want, "Assets/"+l.name)
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("staged %v\nwant %v", got, want)
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
	if !bytes.Contains(m, []byte(`Name="HerdrupCI" Publisher="CN=HerdrupCI" Version="1.1.23.0"`)) {
		t.Errorf("manifest identity:\n%s", m)
	}
}

func TestStageRefuses(t *testing.T) {
	from := t.TempDir()
	good := identity{Name: "Jerry.Herdrup", Publisher: "CN=0A1B2C3D-0000-0000-0000-000000000000", PublisherDisplayName: "Herdrup", Version: "1.1.23.0", Arch: "x64"}
	if err := stage(from, filepath.Join(t.TempDir(), "s"), "../../resources/icon.png", good); err == nil {
		t.Error("staged a folder without herdrup.exe")
	}
	writeFile(t, filepath.Join(from, "herdrup.exe"), "app")
	for _, id := range []identity{
		{Name: "", Publisher: good.Publisher},
		{Name: "Jerry Herdrup", Publisher: good.Publisher},
		{Name: "Jerry_Herdrup", Publisher: good.Publisher},
		{Name: good.Name, Publisher: ""},
		{Name: good.Name, Publisher: "Jerry Fane"},
	} {
		id.Version, id.Arch = good.Version, good.Arch
		if err := stage(from, filepath.Join(t.TempDir(), "s"), "../../resources/icon.png", id); err == nil {
			t.Errorf("staged identity %+v", id)
		}
	}
	if err := stage(from, filepath.Join(t.TempDir(), "s"), "../../resources/icon.png", good); err != nil {
		t.Errorf("Partner Center's identity: %v", err)
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
