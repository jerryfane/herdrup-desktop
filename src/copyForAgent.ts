import { Desk } from "./mygo";

/** Settings' glyph(): an SF Symbol, or its Phosphor stand-in off macOS. */
export type Glyph = (name: string, size: number, weight: string) => HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}

/**
 * The setup guides' footer (AccountsSetupView.swift 158-172, FederationSetupView.swift 156-173):
 * the copy-for-agent card above "Got it". herdrup's federation footer also links the fork's
 * install instructions (InstallInstructionsLink, ForkNoticeView.swift 115); the desktop has no
 * such link, so the guide's own "Install Herdr" step stands in for it.
 */
export function agentGuideFooter(prompt: string, glyph: Glyph, report: (error: unknown) => void, close: () => void): HTMLElement {
  const footer = el("footer", "settings-agent-footer");
  const done = el("button", "settings-agent-done", "Got it"); done.type = "button"; done.onclick = close;
  footer.append(copyForAgentCard(prompt, glyph, report), done);
  return footer;
}

/**
 * CopyForAgentButton.swift: copies the guide as a paste-ready instruction so an agent can perform
 * the setup and report each step. Clipboard write only (line 39). The label swaps to "Copied" with
 * easeOut 0.15 (line 40, --motion-copied) and back after 1.9 s with easeOut 0.2 (lines 42-43,
 * --motion-settle); a second copy restarts the 1.9 s.
 */
function copyForAgentCard(prompt: string, glyph: Glyph, report: (error: unknown) => void): HTMLElement {
  const card = el("div", "settings-agent-card");
  const copy = el("button", "settings-agent-copy"); copy.type = "button"; copy.setAttribute("aria-live", "polite");
  // CopyForAgentButton.swift 19-22.
  const paint = (copied: boolean) => copy.replaceChildren(
    glyph(copied ? "checkmark" : "sparkles", 14, "semibold"),
    el("span", "", copied ? "Copied — paste it to an agent" : "Copy these steps for an agent"),
  );
  paint(false);
  let revert: number | undefined;
  copy.onclick = () => void Desk.gramCopyText(prompt).then(() => {
    clearTimeout(revert); copy.dataset.copied = "true"; paint(true);
    revert = window.setTimeout(() => { copy.dataset.copied = "false"; paint(false); }, 1900);
  }).catch(report);
  // CopyForAgentButton.swift 30-34.
  card.append(copy, el("p", "settings-agent-caption", "Paste into any agent — it'll do it for you and tell you each step."));
  return card;
}
