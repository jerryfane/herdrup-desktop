// Package herdrapi is herdr's API on the wire: the types of every request,
// reply and event line, generated from herdr's schema
// (third_party/herdr/herdr-api.schema.json, pinned in
// third_party/herdr/PROVENANCE.json) into types_gen.go by
// cmd/herdr-api-gen, plus what the schema leaves out, written by hand:
// the method table (methods.go), the streaming methods' params and frames
// (streams.go) and the subscription event decoding (events.go).
//
// # Mapping
//
// Each schema section keeps its own $defs, and the same type appears in
// several; the generator emits one Go type per name and fails when two
// same-named definitions differ in more than their descriptions.
//
//   - An object is a struct with a json tag per property; a section's root
//     is named by its title (Request, SuccessResponse, ErrorResponse,
//     EventEnvelope, ...).
//   - An optional property that may be null, or is a struct or union, is a
//     pointer with omitempty. An optional slice or map keeps nil for
//     absent and uses omitzero, so an empty list still encodes as []. An
//     optional scalar whose schema default is Go's zero value is held as is
//     with omitempty; any other optional scalar is a pointer, so absent and
//     zero stay apart.
//   - A set of strings (enum, or oneOf of string consts) is a named string
//     type with one constant per value. A value a newer herdr adds decodes
//     as is; Known reports whether the pinned schema lists it.
//   - Unknown fields are ignored on decode (encoding/json's default), so a
//     newer herdr's additions do not break the app.
//
// # Tagged unions
//
// A oneOf whose members each fix one property to a distinct string (the
// tag: ResponseResult and EventData by "type", SubscriptionControlLine by
// "control", TranscriptEntry by "kind", ...) is a wrapper struct with one
// field, Value, holding the variant struct for that tag. The variant
// structs omit the tag; the wrapper's MarshalJSON writes it back, and its
// UnmarshalJSON reads the tag first and decodes the whole object into the
// matching variant. Use a type switch:
//
//	switch r := reply.Result.Value.(type) {
//	case herdrapi.ResponseResultPong:
//		_ = r.Capabilities
//	case herdrapi.UnknownVariant:
//		// a reply this pin does not know; r.Raw holds it
//	}
//
// This was chosen over keeping raw JSON with typed decode helpers because
// the decode happens once, where the line is read, and a type switch makes
// the compiler check variant names and field types at every use. Variant
// interfaces are sealed, so only generated variants and UnknownVariant can
// be stored. A tag the pinned schema does not list decodes to
// UnknownVariant and is re-encoded unchanged, so newer servers do not fail
// decoding. Variants are stored as values, not pointers.
//
// Unions without a tag of their own stay json.RawMessage, documented with
// their alternatives: SubscriptionEventData (its kind is the envelope's
// "event"; see SubscriptionEventEnvelope.Payload and
// SubscriptionStreamEvent.Payload), AgentViewValue, AgentViewField,
// AgentViewSortField and PopupSize. SubscriptionStreamEvent flattens
// EventEnvelope or SubscriptionEventEnvelope next to "seq"; its "event" is
// a string and its "data" raw JSON for Payload to decode.
//
// Request decodes "params" as the type its "method" names, using the
// schema's request list; encode a Request with Params set to a params
// struct.
package herdrapi
