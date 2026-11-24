package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"text/template"
)

//go:embed AppxManifest.xml
var manifestTemplate string

// identity is what the manifest says about the package: Partner Center's
// Product identity (or the CI check's placeholder), the version and the
// processor architecture.
type identity struct {
	Name, Publisher, PublisherDisplayName, Version, Arch string
}

// defaultPublisherDisplayName is the publisher users see when the
// repository variable MSIX_PUBLISHER_DISPLAY_NAME is not set.
const defaultPublisherDisplayName = "Herdrup"

// packageName is the form of Identity Name (ST_PackageName): 3 to 50
// letters, digits, dots and dashes.
var packageName = regexp.MustCompile(`^[-.A-Za-z0-9]{3,50}$`)

func (id identity) check() error {
	if !packageName.MatchString(id.Name) {
		return fmt.Errorf("identity name %q: 3 to 50 letters, digits, '.' or '-' (Partner Center, Product identity, Package/Identity/Name)", id.Name)
	}
	if !strings.HasPrefix(id.Publisher, "CN=") {
		return fmt.Errorf("publisher %q: a distinguished name starting with CN= (Partner Center, Product identity, Package/Identity/Publisher)", id.Publisher)
	}
	return nil
}

// manifest returns AppxManifest.xml for id.
func manifest(id identity) ([]byte, error) {
	t, err := template.New("AppxManifest.xml").Funcs(template.FuncMap{"xml": func(s string) (string, error) {
		var b strings.Builder
		err := xml.EscapeText(&b, []byte(s))
		return b.String(), err
	}}).Option("missingkey=error").Parse(manifestTemplate)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	if err := t.Execute(&b, id); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

// semver is package.json's version: X.Y.Z, or X.Y.Z-preview.N, the only
// pre-release herdrup publishes.
var semver = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$`)

// msixVersion turns package.json's version into the package's. The Store
// takes four numbers from 0 to 65535, the first not 0 and the last 0 (it is
// the Store's), and serves the highest version it has, so a newer release
// needs a higher one; a pre-release has no place in it. So
//
//	X.Y.Z-preview.N  ->  (X+1).Y.(Z*1000+N).0
//	X.Y.Z            ->  (X+1).Y.(Z*1000+999).0
//
// which keeps semver's order, previews before their release: 0.1.0-preview.23
// is 1.1.23.0 and 0.1.0 is 1.1.999.0. It fits N up to 998 and Z up to 64.
func msixVersion(v string) (string, error) {
	m := semver.FindStringSubmatch(v)
	if m == nil {
		return "", fmt.Errorf("version %q: want X.Y.Z or X.Y.Z-preview.N", v)
	}
	// Each part is bounded before any arithmetic, which a large one would
	// overflow.
	limits := [4]uint64{65534, 65535, 64, 998}
	var n [4]int
	for i, s := range m[1:] {
		if s == "" {
			continue
		}
		p, err := strconv.ParseUint(s, 10, 64)
		if err != nil || p > limits[i] {
			return "", fmt.Errorf("version %q: %q is past %d, the most a package version fits (X, Y, Z, N)", v, s, limits[i])
		}
		n[i] = int(p)
	}
	pre := 999
	if m[4] != "" {
		pre = n[3]
	}
	return fmt.Sprintf("%d.%d.%d.0", n[0]+1, n[1], n[2]*1000+pre), nil
}

// packageVersion reads the version of package.json at path.
func packageVersion(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var p struct{ Version string }
	if err := json.Unmarshal(b, &p); err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	return p.Version, nil
}

// payload is what the package holds of the Windows build, as the installer
// installs it: the app, and the offline speech engine with its model and
// licences (mygo.config.ts, speechFiles; built first by speech/build.ts).
// Nothing else in the build's folder goes in.
var payload = []string{"herdrup.exe", "herdrup-speech.exe", "ggml-tiny.bin", "whisper-LICENSE", "speech-LICENSES"}

// stageMarker is in each folder stage made, the only kind it replaces. The
// package leaves it out: pack packs the files stage lists.
const stageMarker = ".herdrup-msix-stage"

// logo is an image the manifest names, the app icon centred in it.
type logo struct {
	name       string
	w, h, icon int
}

// logos are the images AppxManifest.xml names, at their base size (scale
// 100), the least the Store takes
// (learn.microsoft.com/windows/apps/design/style/iconography/app-icon-construction).
// Scaled variants (Square44x44Logo.scale-200.png) would need resources.pri.
var logos = []logo{
	{"StoreLogo.png", 50, 50, 50},
	{"Square44x44Logo.png", 44, 44, 44},
	{"Square150x150Logo.png", 150, 150, 150},
	{"Wide310x150Logo.png", 310, 150, 150},
}

// stage makes dir the package's contents: the payload of the build in from,
// the logos made from icon, and AppxManifest.xml for id. It returns them,
// relative to dir. Before writing anything it checks the identity, that
// dir and from are apart, that from has the whole payload, and that dir is
// new, empty or stage's own.
func stage(from, dir, icon string, id identity) ([]string, error) {
	if err := id.check(); err != nil {
		return nil, err
	}
	if err := apart(from, dir); err != nil {
		return nil, err
	}
	for _, name := range payload {
		fi, err := os.Stat(filepath.Join(from, name))
		if err != nil {
			return nil, fmt.Errorf("the build in %s lacks %s (build the speech resources, then the app: README.md, \"Microsoft Store package\"): %w", from, name, err)
		}
		if !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("%s: not a regular file", filepath.Join(from, name))
		}
	}
	if err := claim(dir); err != nil {
		return nil, err
	}
	files := slices.Clone(payload)
	for _, name := range payload {
		if err := copyFile(filepath.Join(from, name), filepath.Join(dir, name)); err != nil {
			return nil, err
		}
	}
	if err := writeLogos(icon, filepath.Join(dir, "Assets")); err != nil {
		return nil, err
	}
	for _, l := range logos {
		files = append(files, "Assets/"+l.name)
	}
	m, err := manifest(id)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "AppxManifest.xml"), m, 0o644); err != nil {
		return nil, err
	}
	return append(files, "AppxManifest.xml"), nil
}

// apart refuses a staging folder that is the build's folder, holds it or
// is inside it, symbolic links followed: replacing it would delete the build.
func apart(from, dir string) error {
	a, err := resolved(from)
	if err != nil {
		return err
	}
	b, err := resolved(dir)
	if err != nil {
		return err
	}
	if within(a, b) || within(b, a) {
		return fmt.Errorf("-stage %s and -from %s overlap: stage in a folder of its own", dir, from)
	}
	return nil
}

// resolved returns p absolute, with the symbolic links of its longest
// existing part resolved.
func resolved(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rest := ""
	for cur := abs; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(r, rest), nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return abs, nil
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// within reports whether p is base or inside it (on Windows, ignoring case,
// as filepath.Rel does).
func within(p, base string) bool {
	rel, err := filepath.Rel(base, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// claim makes dir an empty folder holding stageMarker: from a new folder,
// an empty one, or one stage made before, whose files it deletes. Any other
// it refuses, deleting nothing.
func claim(dir string) error {
	entries, err := os.ReadDir(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return fmt.Errorf("-stage %s: %w", dir, err)
	case len(entries) == 0:
	case !fileExists(filepath.Join(dir, stageMarker)):
		return fmt.Errorf("-stage %s holds files this tool did not stage (no %s): give it a new or empty folder", dir, stageMarker)
	default:
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, stageMarker), []byte("Staged by go run ./packaging/msix, which replaces this folder.\n"), 0o644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// writeLogos writes the logos, made from the PNG icon, into dir.
func writeLogos(icon, dir string) error {
	f, err := os.Open(icon)
	if err != nil {
		return err
	}
	src, err := png.Decode(f)
	f.Close()
	if err != nil {
		return fmt.Errorf("%s: %w", icon, err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, l := range logos {
		img := image.NewRGBA(image.Rect(0, 0, l.w, l.h))
		at := image.Pt((l.w-l.icon)/2, (l.h-l.icon)/2)
		scaledIcon := scaled(src, l.icon, l.icon)
		draw.Draw(img, scaledIcon.Bounds().Add(at), scaledIcon, image.Point{}, draw.Src)
		var b bytes.Buffer
		if err := png.Encode(&b, img); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, l.name), b.Bytes(), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// tap is a source pixel and its share of a scaled pixel.
type tap struct {
	i int
	w float64
}

// taps returns, for each of m pixels scaled from n, the source pixels it
// covers and the share of each: an area average.
func taps(n, m int) [][]tap {
	scale := float64(n) / float64(m)
	out := make([][]tap, m)
	for j := range out {
		lo, hi := float64(j)*scale, float64(j+1)*scale
		for i := int(lo); i < n && float64(i) < hi; i++ {
			if w := min(hi, float64(i+1)) - max(lo, float64(i)); w > 0 {
				out[j] = append(out[j], tap{i, w / scale})
			}
		}
	}
	return out
}

// scaled returns src scaled to w×h, each pixel the average of the source
// area it covers (with premultiplied alpha), which keeps a downscaled icon
// smooth where nearest-neighbour sampling would alias.
func scaled(src image.Image, w, h int) *image.RGBA {
	b := src.Bounds()
	in := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(in, in.Bounds(), src, b.Min, draw.Src)
	xs, ys := taps(b.Dx(), w), taps(b.Dy(), h)
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y, ty := range ys {
		for x, tx := range xs {
			var sum [4]float64
			for _, cy := range ty {
				for _, cx := range tx {
					f := cy.w * cx.w
					p := in.Pix[in.PixOffset(cx.i, cy.i):]
					for c := range sum {
						sum[c] += f * float64(p[c])
					}
				}
			}
			o := out.PixOffset(x, y)
			for c, v := range sum {
				out.Pix[o+c] = uint8(min(255, v+0.5))
			}
		}
	}
	return out
}

// sdkArch is the folder of the Windows SDK's tools for this machine.
func sdkArch() string {
	switch runtime.GOARCH {
	case "arm64":
		return "arm64"
	case "386":
		return "x86"
	}
	return "x64"
}

// sdkTool returns the path of a tool of the Windows SDK, such as makeappx
// or signtool: the one on PATH, else the newest version's in the SDK the
// registry names (KitsRoot10), else in its default folder.
func sdkTool(name string) (string, error) {
	exe := name + ".exe"
	if p, err := exec.LookPath(exe); err == nil {
		return p, nil
	}
	var roots []string
	// The SDK's installer is 32-bit: its key is in the registry's 32-bit view.
	out, err := exec.Command("reg", "query", `HKLM\SOFTWARE\Microsoft\Windows Kits\Installed Roots`, "/v", "KitsRoot10", "/reg:32").Output()
	if err == nil {
		if root := regValue(string(out), "KitsRoot10"); root != "" {
			roots = append(roots, root)
		}
	}
	if pf := os.Getenv("ProgramFiles(x86)"); pf != "" {
		roots = append(roots, filepath.Join(pf, "Windows Kits", "10"))
	}
	for _, root := range roots {
		if p := newestSDKTool(root, exe, sdkArch()); p != "" {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s not found on PATH or in the Windows SDK (%s): install the Windows SDK", exe, strings.Join(roots, ", "))
}

// regValue returns the value of a REG_SZ named name in the output of
// `reg query`, or "".
func regValue(out, name string) string {
	for line := range strings.Lines(out) {
		f := strings.Fields(line)
		if len(f) >= 3 && strings.EqualFold(f[0], name) && f[1] == "REG_SZ" {
			// The value may hold spaces: everything after the type.
			_, v, _ := strings.Cut(line, "REG_SZ")
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// newestSDKTool returns root\bin\<version>\<arch>\<exe> of the highest
// version that has it, else root\bin\<arch>\<exe> (SDKs before 10.0.15063),
// or "" when neither exists.
func newestSDKTool(root, exe, arch string) string {
	bin := filepath.Join(root, "bin")
	entries, _ := os.ReadDir(bin)
	var best string
	var bestVersion []int
	for _, e := range entries {
		v, ok := sdkVersion(e.Name())
		if !ok || !e.IsDir() {
			continue
		}
		p := filepath.Join(bin, e.Name(), arch, exe)
		if _, err := os.Stat(p); err != nil {
			continue
		}
		if best == "" || versionLess(bestVersion, v) {
			best, bestVersion = p, v
		}
	}
	if best != "" {
		return best
	}
	if p := filepath.Join(bin, arch, exe); fileExists(p) {
		return p
	}
	return ""
}

// sdkVersion parses a folder name such as 10.0.26100.0.
func sdkVersion(s string) ([]int, bool) {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return nil, false
	}
	v := make([]int, len(parts))
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nil, false
		}
		v[i] = n
	}
	return v, true
}

func versionLess(a, b []int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// mapping returns the makeappx mapping file that packs files, relative to
// dir, and only them.
func mapping(dir string, files []string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("[Files]\r\n")
	for _, f := range files {
		fmt.Fprintf(&b, "\"%s\" \"%s\"\r\n", filepath.Join(abs, filepath.FromSlash(f)), strings.ReplaceAll(f, "/", `\`))
	}
	return b.String(), nil
}

// pack runs makeappx on files staged in dir, making the package out.
func pack(dir string, files []string, out string) error {
	tool, err := sdkTool("makeappx")
	if err != nil {
		return err
	}
	m, err := mapping(dir, files)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp("", "herdrup-msix-*.txt")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(m); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	cmd := exec.Command(tool, "pack", "/o", "/f", f.Name(), "/p", out)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("makeappx pack: %w", err)
	}
	if !fileExists(out) {
		return errors.New("makeappx made no package")
	}
	return nil
}
