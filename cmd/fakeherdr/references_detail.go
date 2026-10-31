package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

//go:embed detail_grams.json
var detailGrams json.RawMessage

// The owner-side ChatMockConversation and terminal reset at native reference pin
// 9845ecf0743c7dce8073dc4a00db23b1fec069a8. Source: App/ChatMockTranscript.swift
// and Tests/HerdrKitTests/MockWireFixtures.swift. These are synthetic capture
// inputs, not a live agent; unsupported mutations remain errors.
func serveDetailReference(server *fakeherdr.Server) error {
	turns := detailReferenceTurns()
	questions := []any{map[string]any{"question": "Merge #305 and update the servers?", "options": []string{"Yes, merge and deploy", "Not yet"}, "multi": false, "recommended": 0}}
	fallback := server.Handle
	server.HandleSession = func(session, method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
		var p struct {
			Before *string `json:"before"`
			After  *string `json:"after"`
			Limit  *int    `json:"limit"`
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, &fakeherdr.APIError{Code: "invalid_params", Message: err.Error()}
			}
		}
		switch method {
		case "ping":
			return map[string]any{"type": "pong", "version": "0.9.4", "protocol": 22, "capabilities": map[string]bool{"agent_transcript": true, "agent_answer": true, "agent_avatar": true}}, nil
		case "agent.list":
			return json.RawMessage(`{"type":"agent_list","agents":[{"pane_id":"w9:p1","name":"herdr-app","agent":"omp","agent_status":"blocked","cwd":"/root/herdr","terminal_title_stripped":"Merge #305 and update the servers?"},{"pane_id":"w9:p2","terminal_id":"t-keephair","name":"keephair","avatar":{"style":"mascot","mascot":"cub","sha256":null,"updated_unix_ms":1723041000000},"agent":"claude","agent_status":"idle","cwd":"/root/keephair-repo","terminal_title_stripped":"Running the iPad tests"},{"pane_id":"w9:p3","name":"llm-opt","agent":"omp","agent_status":"done","cwd":"/root/llm-opt","terminal_title_stripped":"Bench results posted"}]}`), nil
		case "gram.list":
			// The native MockWireFixtures response is deliberately unfiltered.
			return detailGrams, nil
		case "agent.transcript":
			limit := 20
			if p.Limit != nil {
				limit = max(1, min(*p.Limit, 50))
			}
			end := len(turns)
			start := max(0, end-limit)
			cursor := func(value, prefix string) (int, bool) {
				if !strings.HasPrefix(value, prefix) {
					return 0, false
				}
				n, err := strconv.Atoi(strings.TrimPrefix(value, prefix))
				return n, err == nil && n >= 0 && n <= len(turns)
			}
			if p.Before != nil {
				n, ok := cursor(*p.Before, "t")
				if !ok {
					return nil, &fakeherdr.APIError{Code: "cursor_expired", Message: "unknown cursor"}
				}
				end, start = n, max(0, n-limit)
			} else if p.After != nil {
				n, ok := cursor(*p.After, "a")
				if !ok {
					return nil, &fakeherdr.APIError{Code: "cursor_expired", Message: "unknown cursor"}
				}
				start = max(0, n-1)
			}
			count := 0
			for _, turn := range turns[start:end] {
				count += len(turn)
			}
			entries := make([]map[string]any, 0, count)
			for _, turn := range turns[start:end] {
				entries = append(entries, turn...)
			}
			var before any
			if (p.Before != nil || p.After == nil) && start > 0 {
				before = fmt.Sprintf("t%d", start)
			}
			return map[string]any{"type": "agent_transcript", "agent": "herdr-app", "pane_id": "w9:p1", "session_id": "mock-session", "entries": entries, "before": before, "after": fmt.Sprintf("a%d", len(turns)), "working": nil, "pending_ask": map[string]any{"id": "call_ask_merge", "questions": questions, "answerable": true}}, nil
		case "pane.set_pty_size":
			return json.RawMessage(`{"type":"pane_pty_size","pane_id":"w1:p1","cols":80,"rows":24,"locked":false}`), nil
		case "agent.answer", "agent.prompt", "pane.send_text":
			return nil, &fakeherdr.APIError{Code: "reference_read_only", Message: "The pinned detail capture fixture does not execute commands or answer questions"}
		}
		return fallback(method, raw)
	}
	if server.Streams == nil {
		server.Streams = make(map[string]fakeherdr.StreamFunc)
	}
	server.Streams["pane.stream"] = func(ctx context.Context, id string, raw json.RawMessage, emit func([]byte) error) {
		ack, _ := json.Marshal(map[string]any{"id": id, "result": map[string]any{"type": "stream_started", "pane_id": "w1:p1", "epoch": 7, "cols": 80, "rows": 24, "base_seq": 0, "resync": true}})
		if emit(ack) != nil {
			return
		}
		if emit([]byte(`{"stream":"pane.bytes","frame":"reset","seq":0,"epoch":7,"cols":80,"rows":24,"data_b64":"G1syShtbSBtbMTszODs1OzM5bWhlcmRyG1swbSBsaXZlIHRlcm1pbmFsIOKAlCBtb2NrIHJlbmRlcg0KDQokIGhlcmRyIGFnZW50IGF0dGFjaCBqYXJ2aXMNCj4gUmFuIDE0NiB0ZXN0cywgMCBmYWlsdXJlcw0KDQpbZGVtbyBkYXRhIOKAlCBubyBsaXZlIGNvbm5lY3Rpb25dDQo="}`)) != nil {
			return
		}
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if emit([]byte(`{"stream":"pane.bytes","frame":"ping","seq":0,"epoch":7}`)) != nil {
					return
				}
			}
		}
	}
	return nil
}

func detailReferenceTurns() [][]map[string]any {
	at := func(day, hour, minute int) int64 {
		return time.Date(2026, time.October, day, hour, minute, 0, 0, time.UTC).UnixMilli()
	}
	entry := func(id string, ms int64, fields map[string]any) map[string]any {
		fields["id"], fields["ts_ms"] = id, ms
		return fields
	}
	turns := make([][]map[string]any, 0, 42)
	for i := 0; i < 40; i++ {
		n, ms := i+1, at(28-(41-i), 11, 15)
		turns = append(turns, []map[string]any{
			entry(fmt.Sprintf("f%du", n), ms, map[string]any{"kind": "user", "text": fmt.Sprintf("Synthetic question %d: is check %d green?", n, n), "author": "owner"}),
			entry(fmt.Sprintf("f%ds", n), ms+20000, map[string]any{"kind": "step", "tool": "bash", "intent": fmt.Sprintf("Running check %d", n), "status": "ok"}),
			entry(fmt.Sprintf("f%dr", n), ms+60000, map[string]any{"kind": "reply", "text": fmt.Sprintf("Check %d is green.", n), "final": true}),
			entry(fmt.Sprintf("f%de", n), ms+61000, map[string]any{"kind": "turn_end", "status": "done"}),
		})
	}
	ci := at(28, 14, 5)
	first := []map[string]any{
		entry("o1u", ci, map[string]any{"kind": "user", "text": "Is the herdr fork's CI running again?", "author": "owner"}),
		entry("o1t", ci+4000, map[string]any{"kind": "thinking", "text": "Check the Actions banner and the newest run, not the old queued one."}),
	}
	for i, intent := range []string{"Opening the fork's Actions page", "Reading the newest run", "Checking each platform's job", "Finding the run from Oct 8", "Cancelling the stuck run", "Confirming the queue is empty"} {
		first = append(first, entry(fmt.Sprintf("o1s%d", i), ci+10000+int64(i)*20000, map[string]any{"kind": "step", "tool": "bash", "intent": intent, "status": "ok", "detail": "gh run list --limit 5"}))
	}
	first = append(first,
		entry("o1r", ci+125000, map[string]any{"kind": "reply", "final": true, "text": "Yes. The first run since Oct 8 passed on **macOS, Windows, Linux and Nix**. I cancelled the stuck run from Oct 8, so nothing is queued now."}),
		entry("o1e", ci+126000, map[string]any{"kind": "turn_end", "status": "done"}),
	)
	scroll := at(28, 16, 12)
	second := []map[string]any{
		entry("o2u", scroll, map[string]any{"kind": "user", "author": "owner", "text": "Scrolling up in a terminal stops too early. Keep loading, like Gram."}),
		entry("o2t", scroll+5000, map[string]any{"kind": "thinking", "text": "The phone only gets the last 1,000 rows; the server keeps far more, so the app has to page. Each page should follow its row while the pane keeps writing."}),
	}
	intents := []string{"Reading the scroll code in the terminal view", "Searching for the history cursor", "Reading the pane.history handler", "Writing the paging loop", "Running the unit tests", "Building the app for the simulator", "Running the scroll UI test", "Checking the gaps between pages"}
	for i := 0; i < 112; i++ {
		second = append(second, entry(fmt.Sprintf("o2s%d", i), scroll+10000+int64(i)*20250, map[string]any{"kind": "step", "tool": "bash", "status": "ok", "intent": intents[i%len(intents)], "detail": fmt.Sprintf("step %d of the synthetic run", i+1)}))
	}
	note := scroll + 2290000
	second = append(second,
		entry("o2n", note, map[string]any{"kind": "note", "source": "gitmoot", "title": "Review approved · herdr #305", "from": "herdr-kimi-review", "body": "Approved. The cursor follows its row and the pages meet without gaps."}),
		entry("o2p", note+1000, map[string]any{"kind": "plan", "items": []any{map[string]any{"text": "Page history on the server", "done": true}, map[string]any{"text": "Load it in the app as you scroll", "done": true}, map[string]any{"text": "Test it end to end", "done": true}, map[string]any{"text": "Merge and deploy", "done": false}}}),
		entry("o2r", note+2000, map[string]any{"kind": "reply", "final": false, "text": "Done. Scrolling up now keeps loading older output, **500 lines at a time**, back to the very start.\n\n- Tested on a real server: 3,661 older lines, no gaps, with live output arriving between pages.\n- The app part is in `#477`; the server part is `#305`."}),
		entry("call_ask_merge", note+3000, map[string]any{"kind": "ask", "questions": []any{map[string]any{"question": "Merge #305 and update the servers?", "options": []string{"Yes, merge and deploy", "Not yet"}, "multi": false, "recommended": 0}}}),
	)
	return append(turns, first, second)
}
