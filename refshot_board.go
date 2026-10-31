package main

import (
	"encoding/json"
	"fmt"

	"github.com/egoist/mygo"
)

func driveBoardReference(win *mygo.Window, state string) (bool, string) {
	encoded, _ := json.Marshal(state)
	value, err := win.Page().Eval(`return await (async () => {
  const state = ` + string(encoded) + `;
  const until = async (read, label) => {
    const end = performance.now() + 12000;
    while (performance.now() < end) {
      if (read()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("reference " + state + ": " + label);
  };
  switch (state) {
    case "folders":
      await until(() => document.querySelector('[data-folder="herdr"]') && document.querySelector('[data-folder="enyo"]') && document.querySelector('[data-id="w1:p2"]') && document.querySelector('[data-id="w1:p3"]') && !document.querySelector('[data-id="w2:p1"]'), "Herdr open and Enyo closed");
      break;
    case "avatars":
      await until(() => document.querySelector(".face.photo img") && document.querySelector(".face.mascot") && Array.from(document.querySelectorAll(".face img, img.face")).every(image => image.complete && image.naturalWidth > 0), "photo and mascot loaded");
      break;
    case "sessions":
      await until(() => document.querySelector('.session-pill[title="work, 2 need you"]') && document.querySelector('.session-pill[title="personal"]') && document.querySelector('.session-pill.selected[title="default"]'), "default/personal/work session counts");
      break;
    case "federated":
      await until(() => ["w1:p1", "air/w1:p2", "studio/w1:p4", "nas/w2:p1"].every(id => document.querySelector('[data-id="' + id + '"]')), "all federated agents");
      break;
    case "needs-you-pill": {
      const roster = document.getElementById("roster");
      roster.scrollTop = roster.scrollHeight;
      await until(() => { const pill = document.querySelector(".needs-you-pill"); return pill && !pill.hidden && pill.textContent.includes("3"); }, "3 agents need you at end of roster");
      break;
    }
    case "needs-you-rail": {
      const button = document.querySelector('[aria-label="Minimise sidebar"]');
      if (!button) throw new Error("reference: Minimise sidebar is missing");
      button.click();
      await until(() => document.querySelector('.sidebar-rail:not([hidden]) [aria-label="3 need you"]') && document.querySelector('.sidebar-rail [aria-label="20 working"]') && document.getElementById("detail").getBoundingClientRect().left === 64, "64pt rail with strict activity counts");
      const toggle = () => window.dispatchEvent(new KeyboardEvent("keydown", {key:"k", ctrlKey:true, bubbles:true, cancelable:true}));
      document.querySelector('.sidebar-rail [aria-label="Expand sidebar"]').click();
      await until(() => !document.body.classList.contains("sidebar-minimized") && document.getElementById("detail").getBoundingClientRect().left === 320, "expanded sidebar geometry");
      for (const section of ["Gram", "Settings", "Agents"]) {
        toggle();
        await until(() => document.body.classList.contains("sidebar-minimized"), "keyboard minimize");
        document.querySelector('.sidebar-rail button[aria-label="' + section + '"]').click();
        await until(() => !document.body.classList.contains("sidebar-minimized") && document.getElementById("bar-title").textContent === section, "rail selects and expands " + section);
      }
      toggle();
      await until(() => document.body.classList.contains("sidebar-minimized") && localStorage.getItem("sidebarMinimized") === "true", "remembered minimized state");
      await until(() => window.herdrupRef.ready(), "Agents redraw after section changes");
      break;
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
		return false, fmt.Sprintf("reference state returned %v", value)
	}
	return true, "ready"
}
