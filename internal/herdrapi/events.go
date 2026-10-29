package herdrapi

import (
	"encoding/json"
	"fmt"
)

// subscriptionEventData is the hand-kept half of SubscriptionEventData: the
// schema lists its four structs as an untagged anyOf, and herdr picks the
// one the envelope's "event" names (SubscriptionEventKind, herdr
// src/api/schema/events.rs:394). TestSubscriptionEventKindsDecode fails when
// the schema lists a kind this map lacks.
var subscriptionEventData = map[SubscriptionEventKind]func(json.RawMessage) (any, error){
	SubscriptionEventKindPaneOutputMatched:      decodeAs[PaneOutputMatchedEvent],
	SubscriptionEventKindPaneAgentStatusChanged: decodeAs[PaneAgentStatusChangedEvent],
	SubscriptionEventKindPaneTurnCompleted:      decodeAs[PaneTurnCompletedEvent],
	SubscriptionEventKindPaneScrollChanged:      decodeAs[PaneScrollChangedEvent],
}

func decodeAs[T any](raw json.RawMessage) (any, error) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err
}

// Payload decodes Data as the struct Event names: PaneOutputMatchedEvent,
// PaneAgentStatusChangedEvent, PaneTurnCompletedEvent or
// PaneScrollChangedEvent (values, not pointers). A kind the pinned schema
// does not list gives Data unchanged, as json.RawMessage.
func (e SubscriptionEventEnvelope) Payload() (any, error) {
	decode, ok := subscriptionEventData[e.Event]
	if !ok {
		return json.RawMessage(e.Data), nil
	}
	v, err := decode(json.RawMessage(e.Data))
	if err != nil {
		return nil, fmt.Errorf("%s data: %w", e.Event, err)
	}
	return v, nil
}

// Payload decodes one events.subscribe line's data. A lifecycle event
// (an EventKind such as "pane_created") gives an EventData, whose Value is
// the variant; a subscription event (a dotted SubscriptionEventKind) gives
// its struct as SubscriptionEventEnvelope.Payload does. An event the pinned
// schema does not list gives Data unchanged, as json.RawMessage.
func (e SubscriptionStreamEvent) Payload() (any, error) {
	if EventKind(e.Event).Known() {
		var d EventData
		if err := json.Unmarshal(e.Data, &d); err != nil {
			return nil, fmt.Errorf("%s data: %w", e.Event, err)
		}
		return d, nil
	}
	return SubscriptionEventEnvelope{Event: SubscriptionEventKind(e.Event), Data: SubscriptionEventData(e.Data)}.Payload()
}
