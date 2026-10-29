package gramstore

import (
	"strings"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// AgentName is the bare agent name of a routing name (from, to,
// grabbed_by): the part after the last "/"; a name ending in "/" keeps
// itself (herdrup GramMessage.agentName).
func AgentName(raw string) string {
	i := strings.LastIndex(raw, "/")
	if i < 0 || i == len(raw)-1 {
		return raw
	}
	return raw[i+1:]
}

// SenderName is the sender as people read it: a federated sender's
// machine label in place of its alias, else from (herdrup senderName via
// FederatedName.display).
func SenderName(m herdrapi.GramMessageInfo) string {
	i := strings.Index(m.From, "/")
	if i < 0 || m.MachineLabel == nil || *m.MachineLabel == "" {
		return m.From
	}
	return *m.MachineLabel + "/" + m.From[i+1:]
}

// SenderMachine is the machine for the "name · machine" sender line: the
// daemon's machine_label, else a federated from's alias, else "" (a local
// sender, whose machine the desk knows).
func SenderMachine(m herdrapi.GramMessageInfo) string {
	if m.MachineLabel != nil && *m.MachineLabel != "" {
		return *m.MachineLabel
	}
	if i := strings.Index(m.From, "/"); i > 0 {
		return m.From[:i]
	}
	return ""
}

// AttachmentPreview is the attachment as a one-line preview names it: the
// file's name, "<name> (expired)" for an expired one, "" for none.
func AttachmentPreview(m herdrapi.GramMessageInfo) string {
	switch {
	case m.File != nil:
		return m.File.Name
	case m.ExpiredFile != nil:
		return m.ExpiredFile.Name + " (expired)"
	}
	return ""
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// AgentForSender is the roster agent a Gram sender's routing name denotes
// (herdrup AgentAvatarLookup.agent(forGramSender:)): an agent named exactly
// from, else for a local sender the local agent of that name, and for
// "<machine>/…/<name>" the agent of that name on the machine its id or
// label names.
func AgentForSender(from string, roster []herdrapi.AgentInfo) (herdrapi.AgentInfo, bool) {
	for _, a := range roster {
		if a.Name != nil && *a.Name == from {
			return a, true
		}
	}
	bare := AgentName(from)
	slash := strings.Index(from, "/")
	if slash <= 0 {
		for _, a := range roster {
			if a.MachineID == nil && a.Name != nil && *a.Name == bare {
				return a, true
			}
		}
		return herdrapi.AgentInfo{}, false
	}
	machine := from[:slash]
	for _, a := range roster {
		if str(a.MachineID) != machine && (a.MachineLabel == nil || *a.MachineLabel != machine) {
			continue
		}
		if a.Name != nil && AgentName(*a.Name) == bare {
			return a, true
		}
	}
	return herdrapi.AgentInfo{}, false
}
