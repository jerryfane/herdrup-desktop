// Package apigen pins herdr's API schema and generates the Go types of
// package herdrapi from it (cmd/herdr-api-gen).
package apigen

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const (
	// Repo is where the schema comes from.
	Repo = "jerryfane/herdr"
	// SchemaSource is the schema's path in Repo.
	SchemaSource = "docs/next/api/herdr-api.schema.json"
	// SchemaCopy is the pinned copy here.
	SchemaCopy = "third_party/herdr/herdr-api.schema.json"
	// ProvenancePath records the pinned commit and the copy's hash.
	ProvenancePath = "third_party/herdr/PROVENANCE.json"
	// GoPath is generated from SchemaCopy.
	GoPath = "internal/herdrapi/types_gen.go"
)

// Provenance is the record of the pin.
type Provenance struct {
	Repo   string `json:"repo"`
	Commit string `json:"commit"`
	// Path is the schema's path in Repo at Commit; it is copied to
	// SchemaCopy.
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	// Protocol and SchemaVersion repeat the schema's header, so moving the
	// pin shows a protocol bump in the diff of this file.
	Protocol      int `json:"protocol"`
	SchemaVersion int `json:"schema_version"`
}

// Fetcher reads a file of Repo at a commit.
type Fetcher interface {
	Fetch(ctx context.Context, commit, path string) ([]byte, error)
}

// GitHub fetches from raw.githubusercontent.com; herdr is public.
type GitHub struct{}

// Fetch implements Fetcher.
func (GitHub) Fetch(ctx context.Context, commit, path string) ([]byte, error) {
	url := fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s", Repo, commit, path)
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

var fullSHA = regexp.MustCompile(`^[0-9a-f]{40}$`)

func sum(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

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

// Pin copies the schema at commit into SchemaCopy, records it in
// ProvenancePath and regenerates GoPath. Nothing is written unless the
// schema fetches and generates.
func Pin(ctx context.Context, root, commit string, fetch Fetcher) error {
	if !fullSHA.MatchString(commit) {
		return fmt.Errorf("pin a full 40-character commit, not %q", commit)
	}
	schema, err := fetch.Fetch(ctx, commit, SchemaSource)
	if err != nil {
		return err
	}
	m, err := Load(schema)
	if err != nil {
		return fmt.Errorf("%s at %s: %w", SchemaSource, commit, err)
	}
	goSrc, err := m.Go(commit)
	if err != nil {
		return err
	}
	prov := Provenance{Repo: Repo, Commit: commit, Path: SchemaSource, SHA256: sum(schema), Protocol: m.Protocol, SchemaVersion: m.SchemaVersion}
	data, err := json.MarshalIndent(prov, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFile(root, SchemaCopy, schema); err != nil {
		return err
	}
	if err := writeFile(root, ProvenancePath, append(data, '\n')); err != nil {
		return err
	}
	return writeFile(root, GoPath, goSrc)
}

// ReadProvenance reads ProvenancePath.
func ReadProvenance(root string) (Provenance, error) {
	var p Provenance
	data, err := readFile(root, ProvenancePath)
	if err != nil {
		return p, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return p, fmt.Errorf("%s: %w", ProvenancePath, err)
	}
	if p.Repo != Repo || p.Path != SchemaSource || !fullSHA.MatchString(p.Commit) {
		return p, fmt.Errorf("%s: want repo %s, path %s and a full commit, have %q, %q at %q", ProvenancePath, Repo, SchemaSource, p.Repo, p.Path, p.Commit)
	}
	return p, nil
}

// generated returns what GoPath must contain for the pinned schema.
func generated(root string) ([]byte, *Model, error) {
	prov, err := ReadProvenance(root)
	if err != nil {
		return nil, nil, err
	}
	schema, err := readFile(root, SchemaCopy)
	if err != nil {
		return nil, nil, err
	}
	m, err := Load(schema)
	if err != nil {
		return nil, nil, fmt.Errorf("%s: %w", SchemaCopy, err)
	}
	goSrc, err := m.Go(prov.Commit)
	return goSrc, m, err
}

// Generate rewrites GoPath from the pinned schema.
func Generate(root string) error {
	goSrc, _, err := generated(root)
	if err != nil {
		return err
	}
	return writeFile(root, GoPath, goSrc)
}

// Check verifies, offline, that the pinned schema still has its recorded
// hash and header and that GoPath is what it generates.
func Check(root string) []error {
	prov, err := ReadProvenance(root)
	if err != nil {
		return []error{err}
	}
	var errs []error
	schema, err := readFile(root, SchemaCopy)
	if err != nil {
		return []error{err}
	}
	if got := sum(schema); got != prov.SHA256 {
		errs = append(errs, fmt.Errorf("%s differs from %s %s at %s (sha256 %s, recorded %s); do not edit it, move the pin instead",
			SchemaCopy, Repo, SchemaSource, prov.Commit[:12], got[:12], short(prov.SHA256)))
	}
	goSrc, m, err := generated(root)
	if err != nil {
		return append(errs, err)
	}
	if m.Protocol != prov.Protocol || m.SchemaVersion != prov.SchemaVersion {
		errs = append(errs, fmt.Errorf("%s records protocol %d, schema_version %d, but the schema says %d, %d",
			ProvenancePath, prov.Protocol, prov.SchemaVersion, m.Protocol, m.SchemaVersion))
	}
	if have, _ := readFile(root, GoPath); !bytes.Equal(have, goSrc) {
		errs = append(errs, fmt.Errorf("%s is stale or edited; run go run ./cmd/herdr-api-gen -generate", GoPath))
	}
	return errs
}

// VerifyUpstream checks that the pinned copy is byte for byte the schema
// in Repo at the pinned commit.
func VerifyUpstream(ctx context.Context, root string, fetch Fetcher) []error {
	prov, err := ReadProvenance(root)
	if err != nil {
		return []error{err}
	}
	upstream, err := fetch.Fetch(ctx, prov.Commit, prov.Path)
	if err != nil {
		return []error{err}
	}
	var errs []error
	if got := sum(upstream); got != prov.SHA256 {
		errs = append(errs, fmt.Errorf("%s at %s has sha256 %s, but %s records %s", prov.Path, prov.Commit[:12], got[:12], ProvenancePath, short(prov.SHA256)))
	}
	if local, err := readFile(root, SchemaCopy); err != nil {
		errs = append(errs, err)
	} else if !bytes.Equal(local, upstream) {
		errs = append(errs, fmt.Errorf("%s is not %s %s at %s", SchemaCopy, Repo, prov.Path, prov.Commit[:12]))
	}
	return errs
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
