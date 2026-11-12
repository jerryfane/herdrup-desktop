package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/egoist/mygo"
)

// Exercise the production xterm input/SSH/echo path in the native webview.
// Events are programmatically dispatched; this is not a physical keyboard test.
func smokeTyping(win *mygo.Window, capture string) error {
	value, err := win.Page().Eval(`return await (async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label) => {
    const end = performance.now() + 10000;
    while (performance.now() < end) { const result = read(); if (result) return result; await delay(25); }
    throw new Error("typing smoke: timed out waiting for " + label);
  };
  const clickText = (selector, text) => {
    const element = Array.from(document.querySelectorAll(selector)).find(node => node.textContent.trim() === text);
    if (!element) throw new Error("typing smoke: missing " + text);
    element.click();
  };
  const setMode = mode => {
    const choice = document.getElementById("settings-instant-typing");
    if (!choice) throw new Error("typing smoke: Instant typing missing");
    choice.value = mode; choice.dispatchEvent(new Event("change", { bubbles:true }));
    if (localStorage.getItem("predictiveEcho") !== mode) throw new Error("typing smoke: mode did not persist");
  };
  clickText(".tab", "Settings"); setMode("always");
  clickText(".tab", "Agents");
  document.querySelector(".row").click();
  await until(() => Array.from(document.querySelectorAll("button")).some(node => node.textContent === "Terminal"), "agent controls");
  clickText("button", "Terminal");
  await until(() => document.querySelector(".xterm-rows")?.textContent.includes("input is echoed"), "live SSH fixture");
  const input = document.querySelector(".xterm-helper-textarea"); input.focus();
  const text = () => document.querySelector(".xterm-rows").textContent;
  const key = char => {
    const code = char.toUpperCase().charCodeAt(0);
    input.dispatchEvent(new KeyboardEvent("keydown", {key:char,code:"Key"+char.toUpperCase(),keyCode:code,which:code,bubbles:true,cancelable:true}));
    input.dispatchEvent(new KeyboardEvent("keyup", {key:char,code:"Key"+char.toUpperCase(),keyCode:code,which:code,bubbles:true}));
  };
  let visiblePredictions = 0, expected = "";
  for (const char of "prediction") {
    key(char);
    if (!document.querySelector(".terminal-prediction").hidden) visiblePredictions++;
    expected += char;
    await until(() => text().includes("$ " + expected), "echo " + expected);
    await delay(100);
  }
  if (!visiblePredictions) throw new Error("typing smoke: no overlay before server echo");
  await until(() => document.querySelector(".terminal-prediction").hidden, "confirmed overlay removal");
  clickText(".tab", "Settings");
  clickText("button", "Typing latency");
  const report = await until(() => {
    const node = document.querySelector(".settings-latency-report");
    return node?.textContent.includes("10 measured") ? node.textContent : null;
  }, "ten measured SSH keys");
  if (!report.includes("0 unattributed") || !report.includes("0 failed") || !report.includes("0 withdrawn")) throw new Error("typing smoke: invalid report " + report);
  setMode("off");
  clickText(".tab", "Agents"); input.focus();
  for (const char of "off") {
    key(char);
    if (!document.querySelector(".terminal-prediction").hidden) throw new Error("typing smoke: Off still predicted");
    expected += char;
    await until(() => text().includes("$ " + expected), "Off echo " + expected);
    await delay(100);
  }
  clickText(".tab", "Settings");
  await until(() => document.querySelector(".settings-latency-report")?.textContent.includes("13 measured"), "Off-mode measurements");
  return {visiblePredictions,report,mode:localStorage.getItem("predictiveEcho")};
})()`)
	if err != nil {
		return fmt.Errorf("typing smoke: %w", err)
	}
	proof, ok := value.(map[string]any)
	if !ok || proof["mode"] != "off" {
		return fmt.Errorf("typing smoke: unexpected result %v", value)
	}
	data, err := json.MarshalIndent(proof, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(capture+"-typing.json", data, 0o644); err != nil {
		return err
	}
	png, err := win.CapturePage()
	if err != nil {
		return err
	}
	if err := os.WriteFile(capture+"-typing.png", png, 0o644); err != nil {
		return err
	}
	_, err = win.Page().Eval(`Array.from(document.querySelectorAll(".tab")).find(node => node.textContent.trim() === "Agents").click()`)
	return err
}
