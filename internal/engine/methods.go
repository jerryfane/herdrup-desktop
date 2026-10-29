package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Ping asks herdr for its version, protocol and capabilities, and caches
// the answer for capability checks. A failed ping leaves the cache as it
// was.
func (c *Client) Ping(ctx context.Context) (herdrapi.ResponseResultPong, error) {
	pong, err := call[herdrapi.ResponseResultPong](ctx, c, "ping", herdrapi.PingParams{})
	if err != nil {
		return pong, err
	}
	c.mu.Lock()
	c.probed, c.pong = true, pong
	c.mu.Unlock()
	return pong, nil
}

// MachineStatus is machine.status: the federated machines herdr knows.
func (c *Client) MachineStatus(ctx context.Context) (herdrapi.ResponseResultMachineStatus, error) {
	return call[herdrapi.ResponseResultMachineStatus](ctx, c, "machine.status", herdrapi.EmptyParams{})
}

// AgentList is agent.list.
func (c *Client) AgentList(ctx context.Context, p herdrapi.AgentListParams) (herdrapi.ResponseResultAgentList, error) {
	return call[herdrapi.ResponseResultAgentList](ctx, c, "agent.list", p)
}

// AgentTranscript is agent.transcript (capability agent_transcript).
func (c *Client) AgentTranscript(ctx context.Context, p herdrapi.AgentTranscriptParams) (herdrapi.ResponseResultAgentTranscript, error) {
	return call[herdrapi.ResponseResultAgentTranscript](ctx, c, "agent.transcript", p)
}

// AgentPrompt is agent.prompt.
func (c *Client) AgentPrompt(ctx context.Context, p herdrapi.AgentPromptParams) (herdrapi.ResponseResultAgentPrompted, error) {
	return call[herdrapi.ResponseResultAgentPrompted](ctx, c, "agent.prompt", p)
}

// AgentAnswer is agent.answer (capability agent_answer).
func (c *Client) AgentAnswer(ctx context.Context, p herdrapi.AgentAnswerParams) (herdrapi.ResponseResultAgentAnswer, error) {
	return call[herdrapi.ResponseResultAgentAnswer](ctx, c, "agent.answer", p)
}

// AccountsList is accounts.list: the credential accounts, whose labels
// name the account an agent row shows.
func (c *Client) AccountsList(ctx context.Context) (herdrapi.ResponseResultAccountsList, error) {
	return call[herdrapi.ResponseResultAccountsList](ctx, c, "accounts.list", herdrapi.EmptyParams{})
}

// AgentAvatarGet is agent.avatar.get (capability agent_avatar).
func (c *Client) AgentAvatarGet(ctx context.Context, p herdrapi.AgentAvatarGetParams) (herdrapi.ResponseResultAgentAvatarImage, error) {
	return call[herdrapi.ResponseResultAgentAvatarImage](ctx, c, "agent.avatar.get", p)
}

// AgentAvatarSet is agent.avatar.set (capability agent_avatar).
func (c *Client) AgentAvatarSet(ctx context.Context, p herdrapi.AgentAvatarSetParams) (herdrapi.ResponseResultAgentAvatarSet, error) {
	return call[herdrapi.ResponseResultAgentAvatarSet](ctx, c, "agent.avatar.set", p)
}

// AgentGroupsGet is agent.groups.get (capability agent_groups): the
// owner's folders and stars.
func (c *Client) AgentGroupsGet(ctx context.Context) (herdrapi.ResponseResultAgentGroups, error) {
	return call[herdrapi.ResponseResultAgentGroups](ctx, c, "agent.groups.get", herdrapi.EmptyParams{})
}

// GroupsConflictError is agent.groups.set's groups_conflict: p.Revision
// was not the stored revision. Current is the stored document, onto which
// the caller can replay its edit.
type GroupsConflictError struct {
	Message string
	Current herdrapi.ResponseResultAgentGroups
}

func (e *GroupsConflictError) Error() string {
	return "agent.groups.set: groups_conflict: " + e.Message
}

// AgentGroupsSet is agent.groups.set (capability agent_groups): it
// replaces the whole document, and fails with *GroupsConflictError when
// p.Revision is stale.
func (c *Client) AgentGroupsSet(ctx context.Context, p herdrapi.AgentGroupsSetParams) (herdrapi.ResponseResultAgentGroups, error) {
	r, err := call[herdrapi.ResponseResultAgentGroups](ctx, c, "agent.groups.set", p)
	var api *bridge.APIError
	if err == nil || !errors.As(err, &api) || api.Code != "groups_conflict" {
		return r, err
	}
	var body struct {
		Current *herdrapi.ResponseResultAgentGroups `json:"current"`
	}
	if jerr := json.Unmarshal(api.Raw, &body); jerr != nil || body.Current == nil {
		return r, fmt.Errorf("%w (no stored document in the conflict)", err)
	}
	return r, &GroupsConflictError{Message: api.Message, Current: *body.Current}
}

// PaneHistory is pane.history (capability pane_history): older scrollback
// above a pane.stream reset keyframe.
func (c *Client) PaneHistory(ctx context.Context, p herdrapi.PaneHistoryParams) (herdrapi.ResponseResultPaneHistory, error) {
	return call[herdrapi.ResponseResultPaneHistory](ctx, c, "pane.history", p)
}

// GramSend is gram.send.
func (c *Client) GramSend(ctx context.Context, p herdrapi.GramSendParams) (herdrapi.ResponseResultGramSent, error) {
	return call[herdrapi.ResponseResultGramSent](ctx, c, "gram.send", p)
}

// GramPost is gram.post.
func (c *Client) GramPost(ctx context.Context, p herdrapi.GramPostParams) (herdrapi.ResponseResultGramSent, error) {
	return call[herdrapi.ResponseResultGramSent](ctx, c, "gram.post", p)
}

// GramListing is gram.list's answer: List, or Unchanged when
// IfUnchangedDigest still matched.
type GramListing struct {
	List      *herdrapi.ResponseResultGramList          `json:"list,omitempty"`
	Unchanged *herdrapi.ResponseResultGramListUnchanged `json:"unchanged,omitempty"`
}

// GramList is gram.list.
func (c *Client) GramList(ctx context.Context, p herdrapi.GramListParams) (GramListing, error) {
	v, err := c.do(ctx, "gram.list", p)
	if err != nil {
		return GramListing{}, err
	}
	switch r := v.(type) {
	case herdrapi.ResponseResultGramList:
		return GramListing{List: &r}, nil
	case herdrapi.ResponseResultGramListUnchanged:
		return GramListing{Unchanged: &r}, nil
	}
	return GramListing{}, fmt.Errorf("engine: gram.list result decoded as %T", v)
}

// GramGrab is gram.grab.
func (c *Client) GramGrab(ctx context.Context, p herdrapi.GramGrabParams) (herdrapi.ResponseResultGramGrabbed, error) {
	return call[herdrapi.ResponseResultGramGrabbed](ctx, c, "gram.grab", p)
}

// GramMarkRead is gram.mark_read.
func (c *Client) GramMarkRead(ctx context.Context, p herdrapi.GramMarkReadParams) error {
	_, err := call[herdrapi.ResponseResultOk](ctx, c, "gram.mark_read", p)
	return err
}

// GramDelete is gram.delete.
func (c *Client) GramDelete(ctx context.Context, p herdrapi.GramDeleteParams) error {
	_, err := call[herdrapi.ResponseResultOk](ctx, c, "gram.delete", p)
	return err
}

// GramGetFile is gram.get_file: a message's whole file, inline.
func (c *Client) GramGetFile(ctx context.Context, p herdrapi.GramGetFileParams) (herdrapi.ResponseResultGramFileContent, error) {
	return call[herdrapi.ResponseResultGramFileContent](ctx, c, "gram.get_file", p)
}

// GramGetFileChunk is gram.get_file_chunk: one piece of a message's file.
func (c *Client) GramGetFileChunk(ctx context.Context, p herdrapi.GramGetFileChunkParams) (herdrapi.ResponseResultGramFileChunk, error) {
	return call[herdrapi.ResponseResultGramFileChunk](ctx, c, "gram.get_file_chunk", p)
}

// GramUploadChunk is gram.upload_chunk: one piece of an upload. GramUpload
// sends a whole file.
func (c *Client) GramUploadChunk(ctx context.Context, p herdrapi.GramUploadChunkParams) error {
	_, err := call[herdrapi.ResponseResultOk](ctx, c, "gram.upload_chunk", p)
	return err
}

// GramUploadDiscard is gram.upload.discard: drop an upload never posted.
func (c *Client) GramUploadDiscard(ctx context.Context, p herdrapi.GramUploadDiscardParams) (herdrapi.ResponseResultGramUploadDiscarded, error) {
	return call[herdrapi.ResponseResultGramUploadDiscarded](ctx, c, "gram.upload.discard", p)
}

// The guest methods are owner only. Each takes an optional Machine in its
// params that targets a federated machine instead of this one.

// GuestInviteCreate is guest.invite.create.
func (c *Client) GuestInviteCreate(ctx context.Context, p herdrapi.GuestInviteCreateParams) (herdrapi.ResponseResultGuestInviteCreated, error) {
	return call[herdrapi.ResponseResultGuestInviteCreated](ctx, c, "guest.invite.create", p)
}

// GuestList is guest.list.
func (c *Client) GuestList(ctx context.Context, p herdrapi.GuestListParams) (herdrapi.ResponseResultGuestList, error) {
	return call[herdrapi.ResponseResultGuestList](ctx, c, "guest.list", p)
}

// GuestRevoke is guest.revoke.
func (c *Client) GuestRevoke(ctx context.Context, p herdrapi.GuestRevokeParams) (herdrapi.ResponseResultGuestRevoked, error) {
	return call[herdrapi.ResponseResultGuestRevoked](ctx, c, "guest.revoke", p)
}

// GuestUpdate is guest.update.
func (c *Client) GuestUpdate(ctx context.Context, p herdrapi.GuestUpdateParams) (herdrapi.ResponseResultGuestUpdated, error) {
	return call[herdrapi.ResponseResultGuestUpdated](ctx, c, "guest.update", p)
}

// GuestAudit is guest.audit.
func (c *Client) GuestAudit(ctx context.Context, p herdrapi.GuestAuditParams) (herdrapi.ResponseResultGuestAudit, error) {
	return call[herdrapi.ResponseResultGuestAudit](ctx, c, "guest.audit", p)
}
