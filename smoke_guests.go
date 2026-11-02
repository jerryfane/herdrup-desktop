package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// Uses the stateful fakeherdr guest store, never a live relay or grant.
// Share with someone is an item of the agent page's native ••• menu, which a
// page script cannot click: the script asks for it (__herdrupSmokeShare) and
// this carries out the item the way the menu's click does (choosePaneAction).
func smokeGuestInvite(desk *Desk, win *mygo.Window, capture string) error {
	done := make(chan struct{})
	defer close(done)
	go func() {
		last := ""
		for {
			select {
			case <-done:
				return
			case <-time.After(50 * time.Millisecond):
			}
			v, _ := win.Page().Eval(`return window.__herdrupSmokeShare ?? ""`)
			req, _ := v.(string)
			if req == "" || req == last {
				continue
			}
			last = req
			desk.mu.Lock()
			l := desk.link
			desk.mu.Unlock()
			if l != nil {
				desk.choosePaneAction(l, PaneAction{PaneID: strings.SplitN(req, "#", 2)[0], Action: "share"})
			}
		}
	}()
	value, err := win.Page().Eval(`return await (async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label) => {
    const end = performance.now() + 10000;
    while (performance.now() < end) { const value = read(); if (value) return value; await delay(25); }
    throw new Error("guest smoke: timed out waiting for " + label);
  };
  const clickText = (root, text) => {
    const button = Array.from(root.querySelectorAll("button")).find(node => node.textContent.trim() === text);
    if (!button) throw new Error("guest smoke: missing " + text);
    button.click();
  };
  let shares = 0;
  const open = async () => {
    const pane = document.querySelector(".row.selected")?.dataset.id;
    if (!pane) throw new Error("guest smoke: no agent open");
    window.__herdrupSmokeShare = pane + "#" + (++shares);
    return await until(() => document.querySelector(".guest-share-sheet[open]"), "share sheet");
  };
  const fill = (input, value) => { input.value = value; input.dispatchEvent(new Event("input", {bubbles:true})); };
  let sheet = await open();
  const owner = sheet.querySelector("#guest-invite-owner");
  if (!owner || owner.closest("section").hidden) throw new Error("guest smoke: first share did not ask owner name");
  fill(owner, "CI Owner");
  const name = sheet.querySelector("#guest-invite-name"), create = sheet.querySelector(".guest-create");
  fill(name, "bad name");
  if (!create.disabled) throw new Error("guest smoke: invalid name enabled create");
  fill(name, "native-invite");
  if (sheet.querySelector("#guest-share-gram").checked) throw new Error("guest smoke: Gram consent defaulted on");
  await until(() => !create.disabled, "routed metadata");
  create.click();
  await until(() => sheet.querySelector("#guest-copy-invite"), "created invite");
  if (!sheet.textContent.includes("Not shared")) throw new Error("guest smoke: unrequested Gram grant");
  const first = sheet.textContent;
  clickText(sheet, "Done");
  sheet = await open();
  if (!sheet.querySelector("#guest-invite-owner").closest("section").hidden || localStorage.getItem("guest.ownerName") !== "CI Owner") throw new Error("guest smoke: owner name not retained");
  const gram = sheet.querySelector("#guest-share-gram");
  if (gram.checked) throw new Error("guest smoke: consent leaked between invites");
  fill(sheet.querySelector("#guest-invite-name"), "native-gram"); gram.click();
  await until(() => !sheet.querySelector(".guest-create").disabled, "second routed metadata");
  sheet.querySelector(".guest-create").click();
  const copy = await until(() => sheet.querySelector("#guest-copy-invite"), "Gram invite");
  const gramRow = Array.from(sheet.querySelectorAll(".guest-invite-row")).find(row => row.firstChild.textContent === "Gram");
  if (gramRow?.lastChild.textContent !== "Shared") throw new Error("guest smoke: requested Gram grant absent");
  copy.click(); await until(() => copy.textContent === "Copied", "native clipboard write");
  const qr = sheet.querySelector("canvas"), box = qr.getBoundingClientRect();
  if (box.width !== 138 || box.height !== 138) throw new Error("guest smoke: QR geometry " + JSON.stringify({width:box.width,height:box.height}));
  return {first, second:sheet.textContent, qrWidth:box.width, qrHeight:box.height};
})()`)
	if err != nil {
		return fmt.Errorf("guest smoke: %w", err)
	}
	proof, ok := value.(map[string]any)
	if !ok || proof["second"] == nil {
		return fmt.Errorf("guest smoke: unexpected result %v", value)
	}
	data, err := json.MarshalIndent(proof, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(capture+"-guest.json", data, 0o644); err != nil {
		return err
	}
	png, err := win.CapturePage()
	if err != nil {
		return err
	}
	if err := os.WriteFile(capture+"-guest.png", png, 0o644); err != nil {
		return err
	}
	_, err = win.Page().Eval(`document.querySelector(".guest-share-sheet").close()`)
	return err
}
