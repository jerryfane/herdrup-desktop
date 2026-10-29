package herdrapi

import "encoding/json"

// UnmarshalJSON decodes an AgentInfo, reading `archived` leniently. The
// schema sends an object or null; any other value (false, "", 0) means not
// archived. Strict decoding would fail the whole agent.list over one field,
// and every agent, live ones included, would drop off the board.
func (a *AgentInfo) UnmarshalJSON(b []byte) error {
	type plain AgentInfo // the same fields without this method
	// The outer Archived is shallower than the embedded one, so it takes the
	// "archived" key and the embedded field stays nil.
	aux := struct {
		*plain
		Archived json.RawMessage `json:"archived,omitempty"`
	}{plain: (*plain)(a)}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	a.Archived = nil
	if len(aux.Archived) > 0 && aux.Archived[0] == '{' {
		a.Archived = new(AgentArchivedInfo)
		return json.Unmarshal(aux.Archived, a.Archived)
	}
	return nil
}
