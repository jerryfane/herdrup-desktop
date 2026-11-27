package fakeherdr

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"golang.org/x/crypto/ssh"
)

// herdr#529's fixtures (35b59399: src/pairing.rs, src/api/server/owner_gate/tests.rs).
const (
	pairFixtureKey         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDYBEgq6QqJ3tTOxBY+efdRE3BnChf8Bpq2SozDhVhUF"
	pairFixtureFingerprint = "SHA256:vL7GMFHkifrUqP8D1g/8YJGKWxWjkvRaHfKjeLXytuc"
)

// keyWith is pairing.rs's key_with: an ssh-ed25519 line whose material is
// 32 times b, and its fingerprint.
func keyWith(b byte) (string, string) {
	key, err := ssh.NewPublicKey(ed25519.PublicKey(bytes.Repeat([]byte{b}, ed25519.PublicKeySize)))
	if err != nil {
		panic(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), ssh.FingerprintSHA256(key)
}

// pairKeysReply is pair.keys.list's or pair.keys.remove's reply.
type pairKeysReply struct {
	Type          string
	Keys, Removed []herdrapi.PairKeyInfo
}

func pairCall(p *PairKeys, caller PairCaller, method, params string) (pairKeysReply, *APIError) {
	out, e, ok := p.HandleFrom(caller, method, json.RawMessage(params))
	if !ok {
		panic(method + " not handled")
	}
	var r pairKeysReply
	if e == nil {
		b, _ := json.Marshal(out)
		_ = json.Unmarshal(b, &r)
	}
	return r, e
}

// list_and_remove_touch_only_herdr_pair_lines.
func TestPairKeysListAndRemoveTouchOnlyHerdrPairLines(t *testing.T) {
	mine, mineFP := keyWith(1)
	phone, phoneFP := keyWith(2)
	tablet, tabletFP := keyWith(4)
	p := &PairKeys{}
	// The user's own line holds the same material as the phone's herdr-pair line.
	for _, line := range []string{mine + " me@laptop", phone + " me@phone-by-hand", phone + " old@comment herdr-pair:Jerry's iPhone", tablet + " herdr-pair"} {
		p.AddLine(line)
	}
	listed := []herdrapi.PairKeyInfo{
		{Fingerprint: phoneFP, Label: "Jerry's iPhone", Comment: "old@comment herdr-pair:Jerry's iPhone"},
		{Fingerprint: tabletFP, Label: "", Comment: "herdr-pair"},
	}
	if r, e := pairCall(p, PairOwner, "pair.keys.list", `{}`); e != nil || r.Type != "pair_keys_list" || !slices.Equal(r.Keys, listed) {
		t.Fatalf("list = %+v, %v", r, e)
	}
	// stored_label prefers the herdr-pair line's label to the user's comment.
	if out, e := addKey(p, PairOwner, phone, "Another name"); e != nil || out["already"] != true || out["label"] != "Jerry's iPhone" {
		t.Fatalf("phone again = %v, %v", out, e)
	}
	// A user's own key is not removable here.
	if r, e := pairCall(p, PairOwner, "pair.keys.remove", `{"fingerprint":"`+mineFP+`"}`); e != nil || r.Type != "pair_keys_removed" || r.Removed == nil || len(r.Removed) != 0 {
		t.Fatalf("remove mine = %+v, %v", r, e)
	}
	if r, e := pairCall(p, PairOwner, "pair.keys.remove", `{"fingerprint":"`+phoneFP+`"}`); e != nil || !slices.Equal(r.Removed, listed[:1]) {
		t.Fatalf("remove phone = %+v, %v", r, e)
	}
	if r, e := pairCall(p, PairOwner, "pair.keys.list", ``); e != nil || !slices.Equal(r.Keys, listed[1:]) {
		t.Fatalf("list after remove = %+v, %v", r, e)
	}
	// The user's lines are kept, the phone's with the same material too.
	for key, label := range map[string]string{mine: "me@laptop", phone: "me@phone-by-hand"} {
		if out, e := addKey(p, PairOwner, key, "x"); e != nil || out["already"] != true || out["label"] != label {
			t.Fatalf("%s after remove = %v, %v", label, out, e)
		}
	}
	if keys := p.Keys(); len(keys) != 1 || keys[0].PublicKey != tablet || keys[0].Label != "" || keys[0].Fingerprint != tabletFP {
		t.Fatalf("keys %+v", keys)
	}
}

// pair.add_key writes marked_authorized_key's line, which list reads back.
func TestPairKeysListReadsAddedKeysBack(t *testing.T) {
	p := &PairKeys{}
	if r, e := pairCall(p, PairOwner, "pair.keys.list", `{}`); e != nil || r.Keys == nil || len(r.Keys) != 0 {
		t.Fatalf("empty list = %+v, %v", r, e)
	}
	if _, e := addKey(p, PairOwner, pairFixtureKey+" jerry@phone", "Jerry's  iPhone"); e != nil {
		t.Fatal(e)
	}
	cut := strings.Repeat("a", 47) + " b"
	other, otherFP := keyWith(9)
	if _, e := addKey(p, PairOwner, other, cut); e != nil {
		t.Fatal(e)
	}
	want := []herdrapi.PairKeyInfo{
		{Fingerprint: pairFixtureFingerprint, Label: "Jerry's iPhone", Comment: "herdr-pair:Jerry's iPhone"},
		{Fingerprint: otherFP, Label: strings.Repeat("a", 47), Comment: "herdr-pair:" + strings.Repeat("a", 47)},
	}
	if r, e := pairCall(p, PairOwner, "pair.keys.list", `{}`); e != nil || !slices.Equal(r.Keys, want) {
		t.Fatalf("list = %+v, %v", r, e)
	}
}

// authorized_keys lines are read as sshd reads them (parse_key_line): after
// options, quoted blanks included, with spaces or tabs between fields. A
// user's comment is answered as written on a repeated add; only the list
// and removal output normalise a marked comment's words.
func TestPairKeysReadsLinesAsSshd(t *testing.T) {
	mine, _ := keyWith(1)
	phone, phoneFP := keyWith(2)
	tablet, tabletFP := keyWith(4)
	p := &PairKeys{}
	p.AddLine(`restrict,command="echo \"hi there\"" ` + mine + "   Jerry's   laptop key  \r\n")
	p.AddLine("from=\"10.0.0.1\"\t" + strings.Replace(phone, " ", "\t", 1) + " \therdr-pair:Old   Phone ")
	p.AddLine("  " + tablet + "  herdr-pair")
	for _, bad := range []string{"# " + mine + " herdr-pair", "", `command="unterminated ` + mine, "restrict ssh-ed25519"} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("read a key from %q", bad)
				}
			}()
			p.AddLine(bad)
		}()
	}
	if out, e := addKey(p, PairOwner, mine, "x"); e != nil || out["already"] != true || out["label"] != "Jerry's   laptop key" {
		t.Fatalf("the user's key again = %v, %v", out, e)
	}
	if out, e := addKey(p, PairOwner, phone, "x"); e != nil || out["already"] != true || out["label"] != "Old Phone" {
		t.Fatalf("the phone again = %v, %v", out, e)
	}
	oldPhone := herdrapi.PairKeyInfo{Fingerprint: phoneFP, Label: "Old Phone", Comment: "herdr-pair:Old Phone"}
	want := []herdrapi.PairKeyInfo{oldPhone, {Fingerprint: tabletFP, Label: "", Comment: "herdr-pair"}}
	if r, e := pairCall(p, PairOwner, "pair.keys.list", `{}`); e != nil || !slices.Equal(r.Keys, want) {
		t.Fatalf("list = %+v, %v", r, e)
	}
	if r, e := pairCall(p, PairOwner, "pair.keys.remove", `{"fingerprint":"`+phoneFP+`"}`); e != nil || !slices.Equal(r.Removed, want[:1]) {
		t.Fatalf("remove = %+v, %v", r, e)
	}
	if keys := p.Keys(); len(keys) != 1 || keys[0].PublicKey != tablet {
		t.Fatalf("keys %+v", keys)
	}
}

func addKey(p *PairKeys, caller PairCaller, publicKey, label string) (map[string]any, *APIError) {
	raw, _ := json.Marshal(map[string]string{"public_key": publicKey, "label": label})
	out, e, ok := p.HandleFrom(caller, "pair.add_key", raw)
	if !ok {
		panic("pair.add_key not handled")
	}
	m, _ := out.(map[string]any)
	return m, e
}

func TestPairKeysAddsOnceWithTheStoredLabel(t *testing.T) {
	p := &PairKeys{}
	if _, _, ok := p.Handle("ping", nil); ok {
		t.Fatal("handled ping")
	}
	out, e := addKey(p, PairOwner, pairFixtureKey+" jerry@phone", "Jerry's iPhone")
	if e != nil || out["type"] != "pair_key_added" || out["added"] != true || out["already"] != false ||
		out["fingerprint"] != pairFixtureFingerprint || out["label"] != "Jerry's iPhone" {
		t.Fatalf("add = %v, %v", out, e)
	}
	// A second add of the same material writes nothing and answers the label
	// stored for it (a_repeated_add_replies_with_the_stored_label).
	out, e = addKey(p, PairOwner, pairFixtureKey, "Another name")
	if e != nil || out["added"] != false || out["already"] != true || out["fingerprint"] != pairFixtureFingerprint || out["label"] != "Jerry's iPhone" {
		t.Fatalf("again = %v, %v", out, e)
	}
	retried := &PairKeys{}
	if out, e := addKey(retried, PairOwner, pairFixtureKey, "Old Name"); e != nil || out["added"] != true || out["label"] != "Old Name" {
		t.Fatalf("old name = %v, %v", out, e)
	}
	if out, e := addKey(retried, PairOwner, pairFixtureKey, "New Name"); e != nil || out["added"] != false || out["label"] != "Old Name" {
		t.Fatalf("a changed-label retry = %v, %v", out, e)
	}
	if keys := p.Keys(); len(keys) != 1 || keys[0].PublicKey != pairFixtureKey || keys[0].Label != "Jerry's iPhone" {
		t.Fatalf("keys %+v (the client's comment is dropped)", keys)
	}
	long := "Mac<b>" + strings.Repeat("y", 74)
	other := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb8L/Lx4VtiRK3T4NdDkBRT1ziVYddRSWSNqPDIVQVO"
	if out, e := addKey(p, PairOwner, other, long); e != nil || out["label"] != "Macb"+strings.Repeat("y", 44) {
		t.Fatalf("80 characters stored as %v, %v", out, e)
	}
	// A label cut to 48 just after a space is stored, and first answered,
	// with the space; read back on a repeated add, trimmed.
	cut := strings.Repeat("a", 47) + " b"
	trimmed := &PairKeys{}
	if out, e := addKey(trimmed, PairOwner, pairFixtureKey, cut); e != nil || out["label"] != strings.Repeat("a", 47)+" " {
		t.Fatalf("cut after a space = %v, %v", out, e)
	}
	if out, e := addKey(trimmed, PairOwner, pairFixtureKey, "Another name"); e != nil || out["added"] != false || out["label"] != strings.Repeat("a", 47) {
		t.Fatalf("read back = %v, %v", out, e)
	}
}

func TestPairKeysRefusals(t *testing.T) {
	p := &PairKeys{}
	for _, label := range []string{"", "a\nb", "tab\there", strings.Repeat("x", 81)} {
		if _, e := addKey(p, PairOwner, pairFixtureKey, label); e == nil || e.Code != "pair_label_invalid" {
			t.Errorf("label %q: %v", label, e)
		}
	}
	for _, key := range []string{"ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 user@host", "ssh-ed25519", "ssh-ed25519 AAAA", pairFixtureKey + "\n" + pairFixtureKey} {
		if _, e := addKey(p, PairOwner, key, "Mac"); e == nil || e.Code != "pair_key_invalid" {
			t.Errorf("key %q: %v", key, e)
		}
	}
	if _, e := addKey(p, PairGuest, pairFixtureKey, "guest"); e == nil || e.Code != "guest_forbidden" {
		t.Errorf("guest: %v", e)
	}
	if _, e := addKey(p, PairOwnerBrowser, pairFixtureKey, "browser"); e == nil || e.Code != "owner_forbidden" {
		t.Errorf("owner browser: %v", e)
	}
	if _, e, _ := p.Handle("pair.add_key", json.RawMessage(`{"public_key":"`+pairFixtureKey+`","label":"x","path":"/root"}`)); e == nil {
		t.Error("took an unknown param")
	}
	if n := len(p.Keys()); n != 0 {
		t.Fatalf("%d keys after refusals", n)
	}
	// owner_gate's list and remove: owner-only, as pair.add_key.
	p.AddLine(pairFixtureKey + " herdr-pair:iPhone")
	for method, params := range map[string]string{
		"pair.keys.list":   `{}`,
		"pair.keys.remove": `{"fingerprint":"` + pairFixtureFingerprint + `"}`,
	} {
		for caller, code := range map[PairCaller]string{PairGuest: "guest_forbidden", PairOwnerBrowser: "owner_forbidden"} {
			if _, e := pairCall(p, caller, method, params); e == nil || e.Code != code {
				t.Errorf("%s from %d: %v", method, caller, e)
			}
		}
	}
	for method, params := range map[string]string{
		"pair.keys.list":   `{"all":true}`,
		"pair.keys.remove": `{"fingerprint":"` + pairFixtureFingerprint + `","path":"/root"}`,
	} {
		if _, e := pairCall(p, PairOwner, method, params); e == nil || e.Code != "invalid_params" {
			t.Errorf("%s took %s: %v", method, params, e)
		}
	}
	if _, e := pairCall(p, PairOwner, "pair.keys.remove", `{}`); e == nil || e.Code != "invalid_params" {
		t.Errorf("remove without a fingerprint: %v", e)
	}
	if n := len(p.Keys()); n != 1 {
		t.Fatalf("%d keys after refused removes", n)
	}
}

func TestPongPairAddKeyAdvertisesTheCapability(t *testing.T) {
	if caps := PongPairAddKey(false)["capabilities"].(map[string]bool); !caps["pair_add_key"] {
		t.Fatalf("capabilities %v", caps)
	}
	if caps := Pong(false)["capabilities"].(map[string]bool); caps["pair_add_key"] {
		t.Fatal("Pong shares the map")
	}
}
