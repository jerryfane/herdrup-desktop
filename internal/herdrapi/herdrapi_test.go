package herdrapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/apigen"
)

// schemaModel loads the pinned schema the generated file came from.
func schemaModel(t *testing.T) *apigen.Model {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", filepath.FromSlash(apigen.SchemaCopy)))
	if err != nil {
		t.Fatal(err)
	}
	m, err := apigen.Load(raw)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// unions are the tagged-union wrappers, by schema name.
// TestEveryTaggedVariantDecodes fails when the schema has one this list
// lacks.
var unions = map[string]func() taggedUnion{
	"AgentAvatarChoice":       func() taggedUnion { return new(AgentAvatarChoice) },
	"AgentViewFilter":         func() taggedUnion { return new(AgentViewFilter) },
	"EventData":               func() taggedUnion { return new(EventData) },
	"EventMatch":              func() taggedUnion { return new(EventMatch) },
	"GramGatewayState":        func() taggedUnion { return new(GramGatewayState) },
	"GramRelayCall":           func() taggedUnion { return new(GramRelayCall) },
	"LayoutNode":              func() taggedUnion { return new(LayoutNode) },
	"OutputMatch":             func() taggedUnion { return new(OutputMatch) },
	"PaneMoveDestination":     func() taggedUnion { return new(PaneMoveDestination) },
	"ResponseResult":          func() taggedUnion { return new(ResponseResult) },
	"Subscription":            func() taggedUnion { return new(Subscription) },
	"SubscriptionControlLine": func() taggedUnion { return new(SubscriptionControlLine) },
	"TranscriptEntry":         func() taggedUnion { return new(TranscriptEntry) },
}

type taggedUnion interface {
	json.Unmarshaler
	Tag() string
}

// value is a union's Value field.
func value(u taggedUnion) any { return reflect.ValueOf(u).Elem().FieldByName("Value").Interface() }

func TestEveryTaggedVariantDecodes(t *testing.T) {
	m := schemaModel(t)
	seen := 0
	for _, name := range slices.Sorted(func(yield func(string) bool) {
		for n := range m.Types {
			if !yield(n) {
				return
			}
		}
	}) {
		typ := m.Types[name]
		if typ.Kind != apigen.KindUnion {
			continue
		}
		seen++
		mk, ok := unions[name]
		if !ok {
			t.Errorf("tagged union %s is missing from the test's list", name)
			continue
		}
		for _, v := range typ.Variants {
			line, _ := json.Marshal(map[string]string{typ.TagKey: v.Tag})
			u := mk()
			if err := json.Unmarshal(line, u); err != nil {
				t.Errorf("%s %s: %v", name, line, err)
				continue
			}
			if got := reflect.TypeOf(value(u)); got == nil || got.Name() != v.GoName {
				t.Errorf("%s %s decoded to %v, want %s", name, line, got, v.GoName)
			}
			if u.Tag() != v.Tag {
				t.Errorf("%s %s: Tag() = %q", name, line, u.Tag())
			}
			out, err := json.Marshal(u)
			if err != nil {
				t.Errorf("%s %s: marshal: %v", name, line, err)
				continue
			}
			var back map[string]any
			if err := json.Unmarshal(out, &back); err != nil || back[typ.TagKey] != v.Tag {
				t.Errorf("%s %s re-encoded as %s", name, line, out)
			}
		}
	}
	if seen != len(unions) {
		t.Errorf("the schema has %d tagged unions, the test lists %d", seen, len(unions))
	}
}

func TestUnionKeepsFieldsAndUnknownTags(t *testing.T) {
	var r SuccessResponse
	line := `{"id":"a","result":{"type":"stream_started","pane_id":"p1","epoch":3,"cols":80,"rows":24,"base_seq":9,"resync":true,"added_later":1}}`
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatal(err)
	}
	want := ResponseResultStreamStarted{PaneID: "p1", Epoch: 3, Cols: 80, Rows: 24, BaseSeq: 9, Resync: true}
	if r.Result.Value != want {
		t.Fatalf("decoded %#v", r.Result.Value)
	}
	out, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"id":"a","result":{"type":"stream_started","base_seq":9,"cols":80,"epoch":3,"pane_id":"p1","resync":true,"rows":24}}`; string(out) != want {
		t.Fatalf("encoded %s\nwant    %s", out, want)
	}

	// A tag from a newer herdr survives a round trip.
	line = `{"id":"b","result":{"type":"from_the_future","x":[1,2]}}`
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatal(err)
	}
	u, ok := r.Result.Value.(UnknownVariant)
	if !ok || u.Tag != "from_the_future" {
		t.Fatalf("decoded %#v", r.Result.Value)
	}
	if out, _ := json.Marshal(r); string(out) != line {
		t.Fatalf("re-encoded %s", out)
	}

	// A variant with no fields still carries its tag.
	if out, _ := json.Marshal(ResponseResult{Value: ResponseResultOk{}}); string(out) != `{"type":"ok"}` {
		t.Fatalf("ok encoded as %s", out)
	}
	if err := json.Unmarshal([]byte(`{"no_type":1}`), new(ResponseResult)); err == nil {
		t.Fatal("decoded a result with no type")
	}
}

func TestSubscriptionLines(t *testing.T) {
	var c SubscriptionControlLine
	if err := json.Unmarshal([]byte(`{"control":"lagged","seq":9,"first_missed_seq":4,"last_missed_seq":9}`), &c); err != nil {
		t.Fatal(err)
	}
	if c.Value != (SubscriptionControlLineLagged{Seq: 9, FirstMissedSeq: 4, LastMissedSeq: 9}) {
		t.Fatalf("lagged decoded as %#v", c.Value)
	}

	var e SubscriptionStreamEvent
	if err := json.Unmarshal([]byte(`{"seq":7,"event":"pane_closed","data":{"type":"pane_closed","pane_id":"p1","workspace_id":"w1"}}`), &e); err != nil {
		t.Fatal(err)
	}
	p, err := e.Payload()
	if err != nil {
		t.Fatal(err)
	}
	if d, ok := p.(EventData); !ok || d.Value != (EventDataPaneClosed{PaneID: "p1", WorkspaceID: "w1"}) || e.Seq != 7 {
		t.Fatalf("lifecycle payload %#v, seq %d", p, e.Seq)
	}

	if err := json.Unmarshal([]byte(`{"seq":8,"event":"pane.scroll_changed","data":{"pane_id":"p2","workspace_id":"w1","scroll":{"offset_from_bottom":3,"max_offset_from_bottom":10,"viewport_rows":24}}}`), &e); err != nil {
		t.Fatal(err)
	}
	if p, err = e.Payload(); err != nil {
		t.Fatal(err)
	}
	if s, ok := p.(PaneScrollChangedEvent); !ok || s.PaneID != "p2" || s.Scroll.OffsetFromBottom != 3 {
		t.Fatalf("subscription payload %#v", p)
	}

	e = SubscriptionStreamEvent{Event: "pane.new_kind", Data: json.RawMessage(`{"a":1}`)}
	if p, err = e.Payload(); err != nil || string(p.(json.RawMessage)) != `{"a":1}` {
		t.Fatalf("unknown kind payload %#v, %v", p, err)
	}
}

func TestSubscriptionEventKindsDecode(t *testing.T) {
	kinds := schemaModel(t).Types["SubscriptionEventKind"]
	for _, v := range kinds.Values {
		p, err := SubscriptionEventEnvelope{Event: SubscriptionEventKind(v.Value), Data: SubscriptionEventData(`{}`)}.Payload()
		if err != nil {
			t.Errorf("%s: %v", v.Value, err)
			continue
		}
		if _, raw := p.(json.RawMessage); raw {
			t.Errorf("%s decodes to raw JSON; add it to subscriptionEventData", v.Value)
		}
	}
	// Every decoder is the struct the schema's untagged union lists.
	want := map[string]bool{}
	for _, a := range schemaModel(t).Types["SubscriptionEventData"].Alternatives {
		want[a] = true
	}
	for kind, decode := range subscriptionEventData {
		v, _ := decode(json.RawMessage(`{}`))
		if name := reflect.TypeOf(v).Name(); !want[name] {
			t.Errorf("%s decodes to %s, which SubscriptionEventData does not list", kind, name)
		}
	}
}

func TestRequestDecodesParamsByMethod(t *testing.T) {
	var r Request
	if err := json.Unmarshal([]byte(`{"id":"1","method":"pane.history","params":{"pane_id":"p","cursor":"c","lines":5}}`), &r); err != nil {
		t.Fatal(err)
	}
	p, ok := r.Params.(PaneHistoryParams)
	if !ok || p.PaneID != "p" || p.Cursor != "c" || p.Lines == nil || *p.Lines != 5 {
		t.Fatalf("params %#v", r.Params)
	}
	if err := json.Unmarshal([]byte(`{"id":"2","method":"not.yet","params":{"a":1}}`), &r); err != nil {
		t.Fatal(err)
	}
	if raw, ok := r.Params.(json.RawMessage); !ok || string(raw) != `{"a":1}` {
		t.Fatalf("unknown method params %#v", r.Params)
	}
	out, _ := json.Marshal(Request{ID: "3", Method: "agent.list", Params: AgentListParams{}})
	if string(out) != `{"id":"3","method":"agent.list","params":{}}` {
		t.Fatalf("encoded %s", out)
	}
}

func TestOptionalFields(t *testing.T) {
	// Optional with a false default: plain bool, omitted when false.
	// Optional list: nil is omitted, empty is kept. Nullable: pointer.
	out, _ := json.Marshal(AgentListParams{})
	if string(out) != `{}` {
		t.Fatalf("empty AgentListParams encoded %s", out)
	}
	out, _ = json.Marshal(ResponseResultSubscriptionStarted{Rejected: []SubscriptionRejection{}})
	if string(out) != `{"rejected":[]}` {
		t.Fatalf("empty rejected list encoded %s", out)
	}
	var caps ServerCapabilities
	if err := json.Unmarshal([]byte(`{"live_handoff":true,"endpoint_protocol_generation":null}`), &caps); err != nil {
		t.Fatal(err)
	}
	if !caps.LiveHandoff || caps.EndpointProtocolGeneration != nil || caps.EventsV2 {
		t.Fatalf("capabilities %#v", caps)
	}
}

// The live testdata are replies of herdr 0.9.5 (19296f2, the pin) on the
// build host to `echo '{"id":"x","method":"<m>","params":{}}' | herdr
// api-bridge` (gram.list with {"limit":2}). Names, titles, ids, paths and
// text are replaced by placeholders and long lists cut to the entries that
// cover every field; the structure is herdr's.
var liveReplies = []string{"ping", "agent.list", "agent.groups.get", "machine.status", "gram.list", "guest.list"}

func TestLiveReplies(t *testing.T) {
	for _, method := range liveReplies {
		t.Run(method, func(t *testing.T) {
			line, err := os.ReadFile(filepath.Join("testdata", "live", method+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var r SuccessResponse
			if err := json.Unmarshal(line, &r); err != nil {
				t.Fatal(err)
			}
			m, ok := MethodByName(method)
			if !ok {
				t.Fatalf("%s is not in Methods", method)
			}
			got := reflect.TypeOf(r.Result.Value)
			if !slices.ContainsFunc(m.Results, func(res Result) bool { return res.Type == got }) {
				t.Fatalf("result decoded to %v, Methods says %v", got, m.Results)
			}
			// Every field herdr sent survives decode and re-encode;
			// fields at their zero value may be dropped by omitempty.
			out, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			var want, have any
			_ = json.Unmarshal(line, &want)
			_ = json.Unmarshal(out, &have)
			if w, h := dropZero(want), dropZero(have); !reflect.DeepEqual(w, h) {
				wj, _ := json.Marshal(w)
				hj, _ := json.Marshal(h)
				t.Fatalf("round trip lost data:\nsent %s\nkept %s", wj, hj)
			}
		})
	}
}

func TestLiveReplyValues(t *testing.T) {
	decode := func(method string) ResponseResultVariant {
		line, err := os.ReadFile(filepath.Join("testdata", "live", method+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var r SuccessResponse
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatal(err)
		}
		return r.Result.Value
	}
	pong := decode("ping").(ResponseResultPong)
	if pong.Protocol != Protocol || pong.Capabilities == nil || !CapabilityEventsV2.Supported(pong.Capabilities) || !slices.Contains(pong.Capabilities.AgentSessionTransferHarnesses, AgentSessionTransferHarnessCodex) {
		t.Fatalf("pong %#v", pong)
	}
	list := decode("agent.list").(ResponseResultAgentList)
	if len(list.Agents) != 4 || list.Agents[0].Name == nil || *list.Agents[0].Name != "name-1" || list.Agents[0].AgentStatus != AgentStatusDone || list.OriginCapabilities == nil {
		t.Fatalf("agent list %#v", list)
	}
	machines := decode("machine.status").(ResponseResultMachineStatus)
	if len(machines.Machines) != 3 || machines.Machines["machine-1"].FederationReachability == nil || *machines.Machines["machine-1"].FederationReachability != ReachabilityReachable {
		t.Fatalf("machines %#v", machines)
	}
	if groups := decode("agent.groups.get").(ResponseResultAgentGroups); groups.Revision != 28 || len(groups.Folders) != 3 {
		t.Fatalf("groups %#v", groups)
	}
	if gram := decode("gram.list").(ResponseResultGramList); len(gram.Messages) != 2 || gram.Messages[1].File == nil {
		t.Fatalf("gram %#v", gram)
	}
	if guests := decode("guest.list").(ResponseResultGuestList); len(guests.Guests) == 0 || guests.Link.State != GuestLinkStateUp {
		t.Fatalf("guests %#v", guests)
	}
}

// dropZero removes object members that are false, 0, "" or null, which
// omitempty may leave out.
func dropZero(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			switch e {
			case false, float64(0), "", nil:
				continue
			}
			out[k] = dropZero(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = dropZero(e)
		}
		return out
	}
	return v
}

// requestParams is the schema's method -> params type list.
func requestParams(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, m := range schemaModel(t).Types["Request"].Methods {
		out[m.Name] = m.Params
	}
	return out
}

// handTyped are methods the schema skips, typed in streams.go.
var handTyped = map[string]bool{"pane.stream": true, "gram.upload.stream": true}

func TestMethodTable(t *testing.T) {
	params := requestParams(t)
	model := schemaModel(t)
	tags := map[string]string{}
	for _, v := range model.Types["ResponseResult"].Variants {
		tags[v.Tag] = v.GoName
	}
	seen := map[string]bool{}
	for _, m := range Methods {
		if seen[m.Name] {
			t.Errorf("%s is listed twice", m.Name)
		}
		seen[m.Name] = true
		if m.Params == nil || m.Params.Kind() != reflect.Struct {
			t.Errorf("%s params %v is not a struct", m.Name, m.Params)
		} else if want, inSchema := params[m.Name]; handTyped[m.Name] {
			if inSchema {
				t.Errorf("%s is in the schema now (params %s); use the generated type", m.Name, want)
			}
		} else if !inSchema {
			t.Errorf("%s is not a method in the schema", m.Name)
		} else if m.Params.Name() != want || model.Types[want] == nil {
			t.Errorf("%s params are %s, the schema says %s", m.Name, m.Params.Name(), want)
		}
		if len(m.Results) == 0 {
			t.Errorf("%s has no result", m.Name)
		}
		for _, r := range m.Results {
			if _, ok := tags[r.Tag]; !ok {
				t.Errorf("%s result tag %q is not in the schema's ResponseResult", m.Name, r.Tag)
				continue
			}
			var u ResponseResult
			if err := json.Unmarshal([]byte(`{"type":"`+r.Tag+`"}`), &u); err != nil {
				t.Errorf("%s: %v", m.Name, err)
			} else if got := reflect.TypeOf(u.Value); got != r.Type || got.Name() != tags[r.Tag] {
				t.Errorf("%s result %q decodes to %v, the table says %v", m.Name, r.Tag, got, r.Type)
			}
		}
		if m.Capability != CapabilityNone && capabilityField(m.Capability) < 0 {
			t.Errorf("%s capability %q is not a ServerCapabilities flag", m.Name, m.Capability)
		}
		if m.Streaming != (m.Name == "events.subscribe" || handTyped[m.Name]) {
			t.Errorf("%s streaming = %v", m.Name, m.Streaming)
		}
	}
	for _, name := range []string{
		"ping", "agent.list", "events.subscribe", "pane.stream", "pane.history", "agent.transcript",
		"agent.prompt", "agent.answer", "agent.avatar.get", "agent.avatar.set", "agent.groups.get",
		"agent.groups.set", "machine.status", "guest.invite.create", "guest.list", "guest.revoke",
		"guest.update", "guest.audit",
	} {
		if !seen[name] {
			t.Errorf("%s is missing from Methods", name)
		}
	}
	for name := range params {
		if strings.HasPrefix(name, "gram.") && name != "gram.relay" && !seen[name] {
			t.Errorf("%s is missing from Methods", name)
		}
	}
	if m, ok := MethodByName("agent.groups.set"); !ok || m.Capability != CapabilityAgentGroups {
		t.Errorf("MethodByName(agent.groups.set) = %+v, %v", m, ok)
	}
	if _, ok := MethodByName("nope"); ok {
		t.Error("MethodByName found an unknown method")
	}
}

// capabilityField is the index of c's bool field in ServerCapabilities, or
// -1.
func capabilityField(c Capability) int {
	typ := reflect.TypeFor[ServerCapabilities]()
	for i := range typ.NumField() {
		f := typ.Field(i)
		if strings.Split(f.Tag.Get("json"), ",")[0] == string(c) && f.Type.Kind() == reflect.Bool {
			return i
		}
	}
	return -1
}

func TestCapabilitySupported(t *testing.T) {
	all := []Capability{
		CapabilityEventsV2, CapabilityPaneHistory, CapabilityAgentTranscript, CapabilityAgentAnswer,
		CapabilityAgentAvatar, CapabilityAgentGroups, CapabilityGramUploadStream, CapabilityAPIBridgeMulti,
	}
	for _, c := range all {
		i := capabilityField(c)
		if i < 0 {
			t.Errorf("%s is not a ServerCapabilities flag", c)
			continue
		}
		var only, others ServerCapabilities
		reflect.ValueOf(&only).Elem().Field(i).SetBool(true)
		v := reflect.ValueOf(&others).Elem()
		for j := range v.NumField() {
			if j != i && v.Field(j).Kind() == reflect.Bool {
				v.Field(j).SetBool(true)
			}
		}
		if !c.Supported(&only) || c.Supported(&others) || c.Supported(nil) {
			t.Errorf("%s reads the wrong flag", c)
		}
	}
	if !CapabilityNone.Supported(nil) {
		t.Error("no capability needed, but unsupported")
	}
}

func TestPaneStreamLines(t *testing.T) {
	f, e, err := DecodePaneStreamLine([]byte(`{"stream":"pane.bytes","frame":"reset","seq":10,"epoch":2,"cols":80,"rows":24,"data_b64":"aGk=","lagged":true,"history_b64":"","history_cursor":"c1"}`))
	if err != nil || e != nil {
		t.Fatal(err, e)
	}
	if f.Frame != PaneStreamFrameReset || f.Seq != 10 || *f.Cols != 80 || *f.Rows != 24 || *f.DataB64 != "aGk=" || !f.Lagged || *f.HistoryB64 != "" || *f.HistoryCursor != "c1" {
		t.Fatalf("reset frame %#v", f)
	}
	f, _, err = DecodePaneStreamLine([]byte(`{"stream":"pane.bytes","frame":"ping","seq":11,"epoch":2}`))
	if err != nil || f.Frame != PaneStreamFramePing || f.Cols != nil || f.DataB64 != nil {
		t.Fatalf("ping frame %#v, %v", f, err)
	}
	f, e, err = DecodePaneStreamLine([]byte(`{"id":"s","error":{"code":"guest_paused","message":"paused"}}`))
	if err != nil || f != nil || e == nil || e.Error.Code != "guest_paused" {
		t.Fatalf("error line: %#v %#v %v", f, e, err)
	}
	if _, _, err := DecodePaneStreamLine([]byte(`{"stream":"other","frame":"data"}`)); err == nil {
		t.Fatal("decoded a frame of another stream")
	}
	out, _ := json.Marshal(PaneStreamParams{PaneID: "p"})
	if string(out) != `{"pane_id":"p"}` {
		t.Fatalf("default params encoded %s", out)
	}
}
