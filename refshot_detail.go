package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

type detailReferenceInput struct {
	WriterDraft string `json:"writerDraft"`
	SavedHosts  []struct {
		Host     string `json:"host"`
		User     string `json:"username"`
		Nickname string `json:"nickname"`
		AuthKind string `json:"authKind"`
	} `json:"savedHosts"`
}

func readDetailReferenceInput() (detailReferenceInput, error) {
	var input detailReferenceInput
	raw, err := os.ReadFile(os.Getenv("HERDRUP_REF_FIXTURE"))
	if err != nil {
		return input, err
	}
	err = json.Unmarshal(raw, &input)
	return input, err
}

// Save metadata before the page's first Machines call. No connection is opened;
// the only key path belongs to the throwaway SSH fixture, never to a real host.
func prepareReferenceHosts(desk *Desk) error {
	if !refEnabled() || os.Getenv("HERDRUP_REF_STATE") != "detail-host-selection" {
		return nil
	}
	input, err := readDetailReferenceInput()
	if err != nil {
		return err
	}
	for _, host := range input.SavedHosts {
		m := Machine{Host: host.Host, User: host.User, Nickname: host.Nickname, Port: 22}
		if host.AuthKind == "key" {
			m.KeyPath = os.Getenv("HERDRUP_SMOKE_KEY")
		}
		if err := desk.SaveMachine(m, ""); err != nil {
			return err
		}
	}
	return nil
}

func waitReferenceHosts(win *mygo.Window, w, h int, timeout time.Duration) (bool, string) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		value, err := win.Page().Eval(`return Boolean(document.querySelector('.host-home-rows'))`)
		if err == nil && value == true {
			placeRefWindow(win, w, h)
			return true, "ready"
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false, "saved host selection did not mount"
}

func driveDetailReference(win *mygo.Window, state string) (bool, string) {
	if !strings.HasPrefix(state, "detail-") {
		return true, "ready"
	}
	input, err := readDetailReferenceInput()
	if err != nil {
		return false, err.Error()
	}
	encoded, _ := json.Marshal(map[string]any{"state": state, "draft": input.WriterDraft, "hosts": input.SavedHosts})
	value, err := win.Page().Eval(`return await (async () => {
  const reference = ` + string(encoded) + `;
  const until = async (read, label) => {
    const end = performance.now() + 15000;
    while (performance.now() < end) {
      if (read()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(reference.state + ": " + label);
  };
  if (reference.state === "detail-host-selection") {
    await until(() => reference.hosts.every(host => document.querySelector('.host-home-rows')?.textContent.includes(host.nickname)), "all three saved hosts without connecting");
    if (document.querySelector('.chat-input')) throw new Error("host selection unexpectedly opened a detail");
  } else {
    await until(() => document.querySelector('.row[data-id="w9:p1"]'), "herdr-app row");
    document.querySelector('.row[data-id="w9:p1"]').click();
    await until(() => document.querySelector('.chat-input') && [...document.querySelectorAll('.chat-terminal-switch button')].some(button => button.textContent === "Chat"), "real detail and mode controls");
    const mode = label => [...document.querySelectorAll('.chat-terminal-switch button')].find(button => button.textContent === label);
    if (mode("Chat").getAttribute("aria-pressed") !== "true") mode("Chat").click();
    await until(() => document.querySelector('.chat-transcript')?.textContent.includes("Merge #305 and update the servers?") && document.querySelector('.chat-transcript')?.textContent.includes("500 lines at a time"), "native transcript and pending question");
    const selectedRow = () => document.querySelector('.row[data-id="w9:p1"][aria-current="true"]');
    await until(() => selectedRow()?.querySelector('.row-selection:not([hidden]) svg path'), "selected agent has the native rounded highlight");
    if (reference.state === "detail-chat") {
      document.querySelector('.pane-back').click();
      await until(() => !document.querySelector('.row.selected') && !document.querySelector('.row[aria-current="true"]'), "Back clears sidebar selection");
      document.querySelector('.row[data-id="w9:p1"]').click();
      await until(() => selectedRow() && document.querySelector('.chat-transcript')?.textContent.includes("500 lines at a time"), "reopening restores selection and conversation");
      await document.fonts.ready;
      const reply = [...document.querySelectorAll('.chat-message.reply .chat-markdown')].find(node => node.textContent.includes("500 lines at a time"));
      if (!reply || !getComputedStyle(reply).fontFamily.includes("Geist")) throw new Error("Chat reply uses a browser fallback instead of native Geist");
      const emphasis = reply.querySelector("strong");
      if (!emphasis || getComputedStyle(emphasis).fontWeight !== "600") throw new Error("Chat emphasis does not use native semibold: " + (emphasis ? getComputedStyle(emphasis).fontWeight : "missing emphasis"));
    }
    if (reference.state === "detail-terminal") {
      mode("Terminal").click();
      await until(() => mode("Terminal").getAttribute("aria-pressed") === "true" && document.querySelector('.xterm-rows')?.textContent.includes("mock render"), "real xterm renders native reset bytes");
      document.querySelector('.xterm-helper-textarea')?.blur();
    } else if (reference.state.startsWith("detail-writer-")) {
      const field = document.querySelector('.chat-input');
      field.value = reference.draft; field.setSelectionRange(field.value.length,field.value.length);
      field.dispatchEvent(new Event("input", {bubbles:true})); field.blur();
      const handle = document.querySelector('.chat-composer .composer-expand-handle');
      await until(() => handle && !handle.hidden && handle.getAttribute("aria-label") === "Expand editor", "inline writer expansion handle");
      // ResizeObserver measures the wrapped card before a user can activate its
      // painted handle. Do not click it in the same turn as the synthetic paste.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const collapsed = field.getBoundingClientRect().height;
      if (reference.state === "detail-writer-expanded") {
        handle.click();
        await until(() => handle.getAttribute("aria-label") === "Collapse editor" && field.getBoundingClientRect().height > collapsed + 40, "expanded writer keeps the same textarea");
        if (document.querySelector('.chat-input') !== field || field.value !== reference.draft) throw new Error("writer lost its editor or draft");
        await until(() => {
          const card = field.closest('.chat-composer').getBoundingClientRect();
          const body = document.querySelector('.interaction-body').getBoundingClientRect();
          return card.top >= body.top && card.bottom <= body.bottom;
        }, "expanded writer and collapse handle remain inside the pane");
      }
    }
  }
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`)
	if err != nil {
		return false, err.Error()
	}
	if value != true {
		return false, fmt.Sprintf("detail reference returned %v", value)
	}
	return true, "ready"
}
