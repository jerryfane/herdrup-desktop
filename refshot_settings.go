package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/egoist/mygo"
)

func driveSettingsReference(win *mygo.Window, state string) (bool, string) {
	if !strings.HasPrefix(state, "settings-") {
		return true, "ready"
	}
	encoded, _ := json.Marshal(state)
	value, err := win.Page().Eval(`return await (async () => {
  const state = ` + string(encoded) + `;
  const until = async (read, label) => {
    const end = performance.now() + 15000;
    while (performance.now() < end) {
      if (read()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(state + ": " + label);
  };
  const tab = [...document.querySelectorAll('.t-tab-label')].find(el => el.textContent === "Settings");
  if (!tab) throw new Error("Settings tab missing");
  tab.click();
  const page = () => document.querySelector('.settings-detail:not([hidden])');
  await until(() => page() && document.querySelector('.settings-machine-card[aria-current="page"]'), "Machines selected in Settings split");
  if (state === "settings-machines-empty") {
    await until(() => page().textContent.includes("No saved machines yet.") && document.querySelector('.settings-reach')?.textContent.includes("0 agents"), "empty saved profiles and peers");
    if ([...page().querySelectorAll('button')].some(button => button.textContent === "Federate" || button.textContent === "Unfederate")) throw new Error("empty fixture retained federation actions");
  } else {
    const expected = [["atlas-mini","reachable · 2 agents"],["birch-air","degraded · 1 agent"],["cedar-linux","offline · 1 agent"],["delta-nas","Disabled"],["ember-box","Coordinator off"],["fjord-laptop","Not federated (stale)"],["guest-lab","1 agent"]];
    await until(() => expected.every(([name,status]) => [...document.querySelectorAll('.settings-federation-row')].some(row => row.textContent.includes(name) && row.textContent.includes(status))), "six saved profiles and unsaved guest peer");
    await until(() => { const text = document.querySelector('.settings-reach')?.textContent || ""; return text.includes("5 machines") && text.includes("5 agents") && text.includes("1 offline"); }, "agent-derived federation totals");
  }
  const index = document.querySelector('.settings-index');
  if (state === "settings-machines-federation") {
    const detail = document.querySelector('.settings-page-body'); detail.scrollTop = detail.scrollHeight;
    await until(() => { const frame=detail.getBoundingClientRect(); return [...document.querySelectorAll('.settings-federation-row, .settings-reach')].every(row => {const rect=row.getBoundingClientRect();return rect.top >= frame.top && rect.bottom <= frame.bottom;}); }, "all federation profiles and footer visible at bottom stop");
  } else if (state === "settings-about-index") {
    index.scrollTop = index.scrollHeight;
    await until(() => { const footer=document.querySelector('.settings-version').getBoundingClientRect(); const frame=index.getBoundingClientRect(); return footer.top >= frame.top && footer.bottom <= frame.bottom; }, "inline About and version visible");
  }
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`)
	if err != nil {
		return false, err.Error()
	}
	if value != true {
		return false, fmt.Sprintf("Settings reference returned %v", value)
	}
	return true, "ready"
}
