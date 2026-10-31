import { Desk, type PairedMachine } from "./mygo";
import { scanQR } from "./qrScanner";
import "./pairing.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, run: () => void) { const node = el("button", "", text); node.type = "button"; node.onclick = run; return node; }
let active: HTMLDialogElement | null = null;

export function showPairing(saved: () => Promise<void>, open: (machine: PairedMachine) => Promise<void>, manual: () => void) {
  active?.close();
  let disposed = false, stopCamera: (() => void) | null = null, phase: "scan" | "pair" | "result" = "scan";
  const sheet = el("dialog", "settings-sheet pairing-sheet"), header = el("header", "settings-sheet-header"), heading = el("h2", "", "Scan to connect");
  heading.id = "pairing-title"; sheet.setAttribute("aria-labelledby", heading.id);
  header.append(heading, button("Cancel", () => sheet.close()));
  const content = el("div", "pairing-content"); content.setAttribute("aria-live", "polite"); sheet.append(header, content);
  function stop() { stopCamera?.(); stopCamera = null; }
  function failure(title: string, message: string) {
    if (disposed) return;
    stop(); phase = "result";
    content.replaceChildren(el("h3", "", title), el("p", "", message), button("Try again", start), button("Add host manually", () => { sheet.close(); manual(); }));
  }
  async function found(text: string) {
    if (disposed || phase !== "scan") return;
    stop();
    // Cheap shape validation happens before showing Connecting. The backend owns
    // authoritative version, address and fingerprint validation and all secrets.
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (!value || typeof value !== "object" || !Number.isInteger(value.v) || !Number.isInteger(value.port) || [value.host, value.user, value.token, value.fp].some(field => typeof field !== "string")) throw new Error("not a pairing payload");
    } catch { failure("Pairing didn't work", "That code isn't a herdr pairing code. On your computer, run herdr pair and scan the code it prints."); return; }
    phase = "pair"; content.replaceChildren(el("p", "pairing-progress", "Connecting…"));
    try {
      const machine = await Desk.pairMachine(text);
      await saved(); if (disposed) return;
      phase = "result";
      const openButton = button("Open it", () => {
        openButton.disabled = true;
        void open(machine).then(() => { if (!disposed) sheet.close(); }).catch(error => {
          if (disposed) return;
          openButton.disabled = false;
          status.textContent = `The host is saved, but couldn't connect: ${String(error)}`; status.hidden = false;
        });
      });
      const status = el("p", "pairing-error"); status.hidden = true; status.setAttribute("role", "status");
      const command = el("code", "pairing-command", "herdr");
      content.replaceChildren(el("h3", "", "Connected"), el("p", "", `${machine.nickname} is saved on this device. If herdr isn't running on that computer yet, start it there:`), command, button("Copy command", () => { void Desk.gramCopyText("herdr").catch(error => { if (!disposed) { status.textContent = String(error); status.hidden = false; } }); }), openButton, status);
    } catch (error) { failure("Pairing didn't work", String(error)); }
  }
  function start() {
    if (disposed || phase === "pair") return;
    stop(); phase = "scan";
    const camera = el("div", "pairing-camera"), video = el("video"); video.muted = true; video.playsInline = true; video.autoplay = true;
    video.setAttribute("aria-label", "Pairing code camera");
    const frame = el("div", "pairing-guide"); frame.setAttribute("aria-hidden", "true"); camera.append(video, frame);
    content.replaceChildren(camera, el("p", "", "On your computer, run herdr pair. Point the camera at the code it prints. Both devices must be on the same private network."));
    stopCamera = scanQR(video, text => { void found(text); }, message => failure("Can't use the camera", message));
  }
  sheet.addEventListener("close", () => { disposed = true; stop(); if (active === sheet) active = null; sheet.remove(); }, { once: true });
  active = sheet; document.body.append(sheet); sheet.showModal(); start();
}
