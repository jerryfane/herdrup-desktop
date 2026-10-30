package herdrapi

import "reflect"

// Method is one herdr API method the app calls. herdr's schema lists each
// method's params but not what it answers, which capability gates it, or
// whether it streams, so this table keeps those by hand. Each entry cites
// its line in herdr's operation catalogue (define_operations! in
// src/api/schema.rs) and where herdr builds its result, at the pinned
// commit. TestMethodTable checks every type and result tag against the
// generated schema types.
type Method struct {
	// Name is the wire "method".
	Name string
	// Params is the params type, a struct; encode a value of it.
	Params reflect.Type
	// Results are the success replies, by their "type" tag. For a
	// streaming method this is the acknowledgement on the first line.
	Results []Result
	// Capability is the ServerCapabilities flag a server must advertise for
	// the method (or, for events.subscribe, for the contract typed here);
	// "" when every server in scope has it. herdr without the method
	// answers unknown_method.
	Capability Capability
	// Streaming methods keep the connection open after the
	// acknowledgement. herdr refuses them on `api-bridge --multi`
	// (src/remote.rs:36-42), so each needs its own bridge process.
	Streaming bool
}

// Result is one success reply of a method.
type Result struct {
	// Tag is the reply's ResponseResult "type".
	Tag string
	// Type is the ResponseResult variant struct the tag decodes to.
	Type reflect.Type
}

// Capability is a boolean ServerCapabilities flag, by its JSON name.
type Capability string

const (
	CapabilityNone             Capability = ""
	CapabilityEventsV2         Capability = "events_v2"
	CapabilityPaneHistory      Capability = "pane_history"
	CapabilityAgentTranscript  Capability = "agent_transcript"
	CapabilityAgentAnswer      Capability = "agent_answer"
	CapabilityAgentAvatar      Capability = "agent_avatar"
	CapabilityAgentGroups      Capability = "agent_groups"
	CapabilityGramUploadStream Capability = "gram_upload_stream"
	CapabilityAPIBridgeMulti   Capability = "api_bridge_multi"
)

// Supported reports whether caps advertises c. CapabilityNone is always
// supported; any other flag is unsupported when caps is nil (a herdr older
// than capabilities, or a ping that has not answered).
func (c Capability) Supported(caps *ServerCapabilities) bool {
	if c == CapabilityNone {
		return true
	}
	if caps == nil {
		return false
	}
	switch c {
	case CapabilityEventsV2:
		return caps.EventsV2
	case CapabilityPaneHistory:
		return caps.PaneHistory
	case CapabilityAgentTranscript:
		return caps.AgentTranscript
	case CapabilityAgentAnswer:
		return caps.AgentAnswer
	case CapabilityAgentAvatar:
		return caps.AgentAvatar
	case CapabilityAgentGroups:
		return caps.AgentGroups
	case CapabilityGramUploadStream:
		return caps.GramUploadStream
	case CapabilityAPIBridgeMulti:
		return caps.APIBridgeMulti
	}
	return false
}

func typeOf[T any]() reflect.Type { return reflect.TypeFor[T]() }

func result[T ResponseResultVariant](tag string) Result {
	return Result{Tag: tag, Type: typeOf[T]()}
}

// Methods are the methods the app calls, in herdr's catalogue order.
// gram.relay (herdr-to-herdr) and other internal methods are left out.
var Methods = []Method{
	// schema.rs:60; pong built at src/api/server.rs:2427.
	{Name: "ping", Params: typeOf[PingParams](), Results: []Result{result[ResponseResultPong]("pong")}},
	// schema.rs:64; src/app/api/machines.rs:14.
	{Name: "machine.status", Params: typeOf[EmptyParams](), Results: []Result{result[ResponseResultMachineStatus]("machine_status")}},
	// schema.rs:154; src/app/api/accounts.rs:125.
	{Name: "accounts.list", Params: typeOf[EmptyParams](), Results: []Result{result[ResponseResultAccountsList]("accounts_list")}},
	// schema.rs:82; src/app/api/gram.rs:389.
	{Name: "gram.send", Params: typeOf[GramSendParams](), Results: []Result{result[ResponseResultGramSent]("gram_sent")}},
	// schema.rs:83; gram.rs:469.
	{Name: "gram.post", Params: typeOf[GramPostParams](), Results: []Result{result[ResponseResultGramSent]("gram_sent")}},
	// schema.rs:84; gram.rs:577 (the caller's digest still matches) and
	// gram.rs:599.
	{Name: "gram.list", Params: typeOf[GramListParams](), Results: []Result{
		result[ResponseResultGramList]("gram_list"),
		result[ResponseResultGramListUnchanged]("gram_list_unchanged"),
	}},
	// schema.rs:85; gram.rs:666.
	{Name: "gram.grab", Params: typeOf[GramGrabParams](), Results: []Result{result[ResponseResultGramGrabbed]("gram_grabbed")}},
	// schema.rs:86; gram.rs:716.
	{Name: "gram.mark_read", Params: typeOf[GramMarkReadParams](), Results: []Result{result[ResponseResultOk]("ok")}},
	// schema.rs:87; gram.rs:763.
	{Name: "gram.delete", Params: typeOf[GramDeleteParams](), Results: []Result{result[ResponseResultOk]("ok")}},
	// schema.rs:88; gram.rs:806.
	{Name: "gram.upload_chunk", Params: typeOf[GramUploadChunkParams](), Results: []Result{result[ResponseResultOk]("ok")}},
	// schema.rs:89; gram.rs:840.
	{Name: "gram.upload.discard", Params: typeOf[GramUploadDiscardParams](), Results: []Result{result[ResponseResultGramUploadDiscarded]("gram_upload_discarded")}},
	// schema.rs:90; gram.rs:902.
	{Name: "gram.get_file", Params: typeOf[GramGetFileParams](), Results: []Result{result[ResponseResultGramFileContent]("gram_file_content")}},
	// schema.rs:91; gram.rs:967.
	{Name: "gram.get_file_chunk", Params: typeOf[GramGetFileChunkParams](), Results: []Result{result[ResponseResultGramFileChunk]("gram_file_chunk")}},
	// schema.rs:95; gram.rs:129.
	{Name: "gram.relay_status", Params: typeOf[EmptyParams](), Results: []Result{result[ResponseResultGramRelayStatus]("gram_relay_status")}},
	// schema.rs:98; src/api/server/guest_owner.rs:123. Owner only.
	{Name: "guest.invite.create", Params: typeOf[GuestInviteCreateParams](), Results: []Result{result[ResponseResultGuestInviteCreated]("guest_invite_created")}},
	// schema.rs:99; guest_owner.rs:132.
	{Name: "guest.list", Params: typeOf[GuestListParams](), Results: []Result{result[ResponseResultGuestList]("guest_list")}},
	// schema.rs:100; guest_owner.rs:140.
	{Name: "guest.revoke", Params: typeOf[GuestRevokeParams](), Results: []Result{result[ResponseResultGuestRevoked]("guest_revoked")}},
	// schema.rs:101; guest_owner.rs:154.
	{Name: "guest.update", Params: typeOf[GuestUpdateParams](), Results: []Result{result[ResponseResultGuestUpdated]("guest_updated")}},
	// schema.rs:102; guest_owner.rs:164.
	{Name: "guest.audit", Params: typeOf[GuestAuditParams](), Results: []Result{result[ResponseResultGuestAudit]("guest_audit")}},
	{Name: "pane.send_text", Params: typeOf[PaneSendTextParams](), Results: []Result{result[ResponseResultOk]("ok")}},
	{Name: "pane.set_pty_size", Params: typeOf[PaneSetPtySizeParams](), Results: []Result{result[ResponseResultPanePTYSize]("pane_pty_size")}},
	// schema.rs:131; src/app/api/agents.rs:59.
	{Name: "agent.list", Params: typeOf[AgentListParams](), Results: []Result{result[ResponseResultAgentList]("agent_list")}},
	// schema.rs:134; src/app/api/transcript.rs:122.
	{Name: "agent.transcript", Params: typeOf[AgentTranscriptParams](), Results: []Result{result[ResponseResultAgentTranscript]("agent_transcript")}, Capability: CapabilityAgentTranscript},
	// schema.rs:138; agents.rs:253.
	{Name: "agent.avatar.set", Params: typeOf[AgentAvatarSetParams](), Results: []Result{result[ResponseResultAgentAvatarSet]("agent_avatar_set")}, Capability: CapabilityAgentAvatar},
	// schema.rs:139; agents.rs:291.
	{Name: "agent.avatar.get", Params: typeOf[AgentAvatarGetParams](), Results: []Result{result[ResponseResultAgentAvatarImage]("agent_avatar_image")}, Capability: CapabilityAgentAvatar},
	// schema.rs:140; agents.rs:1228.
	{Name: "agent.groups.get", Params: typeOf[EmptyParams](), Results: []Result{result[ResponseResultAgentGroups]("agent_groups")}, Capability: CapabilityAgentGroups},
	// schema.rs:141; agents.rs:1228. A stale revision fails with
	// groups_conflict, whose error also carries "current" (not in the
	// schema; src/api/schema/agents.rs:217-223).
	{Name: "agent.groups.set", Params: typeOf[AgentGroupsSetParams](), Results: []Result{result[ResponseResultAgentGroups]("agent_groups")}, Capability: CapabilityAgentGroups},
	// schema.rs:149; agents.rs:423.
	{Name: "agent.prompt", Params: typeOf[AgentPromptParams](), Results: []Result{result[ResponseResultAgentPrompted]("agent_prompted")}},
	// schema.rs:151; src/api/answer.rs:63.
	{Name: "agent.answer", Params: typeOf[AgentAnswerParams](), Results: []Result{result[ResponseResultAgentAnswer]("agent_answer")}, Capability: CapabilityAgentAnswer},
	// schema.rs:192; src/app/api/panes.rs:1905.
	{Name: "pane.history", Params: typeOf[PaneHistoryParams](), Results: []Result{result[ResponseResultPaneHistory]("pane_history")}, Capability: CapabilityPaneHistory},
	// schema.rs:194; acknowledged at src/api/server/pane_output_stream.rs:249,
	// then PaneStreamFrame lines. No flag gates the method; pane_history
	// gates PaneStreamFrame.HistoryCursor.
	{Name: "pane.stream", Params: typeOf[PaneStreamParams](), Results: []Result{result[ResponseResultStreamStarted]("stream_started")}, Streaming: true},
	// schema.rs:216; acknowledged at src/api/server/gram_upload_stream.rs:207,
	// then GramUploadFrame out and GramUploadFrameReply back.
	{Name: "gram.upload.stream", Params: typeOf[GramUploadStreamParams](), Results: []Result{result[ResponseResultOk]("ok")}, Capability: CapabilityGramUploadStream, Streaming: true},
	// schema.rs:227; acknowledged at src/api/server.rs:2793, then
	// SubscriptionStreamEvent and SubscriptionControlLine lines. A herdr
	// without events_v2 accepts the call but ignores events_v2: its lines
	// have no seq and no control lines.
	{Name: "events.subscribe", Params: typeOf[EventsSubscribeParams](), Results: []Result{result[ResponseResultSubscriptionStarted]("subscription_started")}, Capability: CapabilityEventsV2, Streaming: true},
}

// MethodByName returns the Methods entry for a wire name.
func MethodByName(name string) (Method, bool) {
	for _, m := range Methods {
		if m.Name == name {
			return m, true
		}
	}
	return Method{}, false
}
