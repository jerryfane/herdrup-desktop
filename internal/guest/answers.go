package guest

import (
	"context"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// A guest answers the shared agent's questions as the owner does (herdr
// #352, src/api/server/guest_gate.rs at d78b91c): agent.answer for an omp
// ask, and menu keys through pane.send_keys while the agent waits on a menu.
// The gate serves both without advertising them: its pong carries only
// agent_transcript and agent_avatar (guest_gate.rs:421-435), so these calls
// go straight to the relay rather than through engine's capability gate. A
// host older than #352 refuses both with guest_forbidden (bridge.APIError).

// AgentAnswer is agent.answer on the granted agent (guest_gate.rs:972-991).
func (t *Transport) AgentAnswer(ctx context.Context, params herdrapi.AgentAnswerParams) (herdrapi.ResponseResultAgentAnswer, error) {
	var reply herdrapi.ResponseResultAgentAnswer
	err := t.Call(ctx, "agent.answer", params, &reply)
	return reply, err
}

// SendMenuKeys is pane.send_keys on the granted pane. The gate takes only
// menu keys, at most one that commits the menu and that one last, and only
// while the agent awaits menu input (guest_gate.rs:472-524, 992-1038).
func (t *Transport) SendMenuKeys(ctx context.Context, pane string, keys []string) error {
	return t.Call(ctx, "pane.send_keys", herdrapi.PaneSendKeysParams{PaneID: pane, Keys: keys}, nil)
}
