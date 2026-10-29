package herdr

import (
	"strings"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Mascots are the mascot ids herdrup ships, in its picker order
// (HerdrKit AgentMascot). Each one's art is public/herdrup/mascots/<id>.svg.
var Mascots = []string{"herdy", "bot", "blip", "tri", "squib", "zag", "cub", "dome", "pip", "prism", "nib", "drop"}

// Avatar is what an agent's avatar draws, resolved the way herdrup's
// AgentAvatarAppearance is.
type Avatar struct {
	// Kind is "initial" (the initial tile), "mascot" or "image".
	Kind string `json:"kind"`
	// Mascot is the mascot id for kind mascot.
	Mascot string `json:"mascot,omitempty"`
	// SHA256 is the photo's lowercase hex sha256 for kind image.
	SHA256 string `json:"sha256,omitempty"`
	// Target is what agent.avatar.get addresses the agent by.
	Target string `json:"target,omitempty"`
}

// AvatarOf resolves an agent's avatar: a known mascot, a photo with a valid
// sha256, else the initial tile (an unknown style or mascot id, a bad sha or
// no choice at all).
func AvatarOf(a herdrapi.AgentInfo) Avatar {
	if a.Avatar == nil {
		return Avatar{Kind: "initial"}
	}
	switch a.Avatar.Style {
	case herdrapi.AgentAvatarStyleMascot:
		if m := str(a.Avatar.Mascot); isMascot(m) {
			return Avatar{Kind: "mascot", Mascot: m}
		}
	case herdrapi.AgentAvatarStyleImage:
		// herdrup lower-cases the sha on decode, then requires 64 hex.
		if sha := strings.ToLower(str(a.Avatar.SHA256)); ValidSHA256(sha) {
			return Avatar{Kind: "image", SHA256: sha, Target: AvatarTarget(a)}
		}
	}
	return Avatar{Kind: "initial"}
}

func isMascot(id string) bool {
	for _, m := range Mascots {
		if m == id {
			return true
		}
	}
	return false
}

// ValidSHA256 reports whether s is 64 lowercase hex digits.
func ValidSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := range len(s) {
		if c := s[i]; !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// AvatarTarget is herdrup's avatarTarget: a local agent's terminal id, a
// federated agent's prefixed pane id (its home routes that to the peer),
// and for an agent with no pane its terminal id or name.
func AvatarTarget(a herdrapi.AgentInfo) string {
	if a.MachineID == nil && a.TerminalID != "" {
		return a.TerminalID
	}
	if a.PaneID != "" {
		return a.PaneID
	}
	if a.TerminalID != "" {
		return a.TerminalID
	}
	if n := str(a.Name); n != "" {
		return n
	}
	return a.PaneID
}
