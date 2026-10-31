import qrcode from "qrcode-generator";
import { Desk } from "./mygo";
import { guestName, guestOwnerName, inviteValidity, shareableInviteURL, type CreatedGuestInvite } from "./guestInviteModel";
import "./guestShare.css";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(text: string, run: () => void) {
  const node = el("button", "guest-pill", text); node.type = "button"; node.onclick = run; return node;
}
function section(label: string, ...nodes: HTMLElement[]) {
  const root = el("section", "guest-section"), card = el("div", "guest-card");
  card.append(...nodes); root.append(el("h3", "guest-section-title", label), card); return root;
}
function field(label: string, input: HTMLInputElement, hint: HTMLElement) {
  const edit = el("span", "guest-edit-label", "EDIT"); edit.setAttribute("aria-hidden", "true");
  const root = section(label, input, edit); root.children[1]!.classList.add("guest-edit-field");
  root.append(hint); return root;
}

export function openGuestShare(token: string, agentName: string): HTMLDialogElement {
  const dialog = el("dialog", "guest-share-sheet"); dialog.setAttribute("aria-label", "Share with someone");
  const header = el("header"), title = el("h2", "", "Share with someone");
  header.append(title, button("Done", () => dialog.close()));
  const content = el("div", "guest-share-content"), failure = el("p", "guest-failure"); failure.setAttribute("role", "alert"); failure.hidden = true;
  const report = (error: unknown) => { if (dialog.isConnected) { failure.textContent = String(error); failure.hidden = false; } };
  const heading = el("h2", "guest-share-heading", `Share ${agentName}`);
  const subtitle = el("p", "guest-share-subtitle", "They see only this agent. No SSH, no other agents.");
  const form = el("form"), name = el("input"); name.placeholder = "Their name"; name.autocomplete = "off"; name.setAttribute("aria-label", "Their name"); name.id = "guest-invite-name";
  name.autocapitalize = "none"; name.spellcheck = false;
  const nameHelp = el("p", "guest-field-hint", "Up to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit."); nameHelp.hidden = true;
  const owner = el("input"); owner.placeholder = "Jerry"; owner.autocomplete = "given-name"; owner.setAttribute("aria-label", "Your name"); owner.id = "guest-invite-owner";
  let savedOwner = "";
  try { savedOwner = guestOwnerName(localStorage.getItem("guest.ownerName") ?? "") ?? ""; } catch { /* First share asks for a name. */ }
  const askOwner = !savedOwner;
  const ownerHint = el("p", "guest-field-hint");
  const ownerSection = field("YOUR NAME", owner, ownerHint); ownerSection.hidden = !askOwner;
  const preview = el("p", "guest-label-preview");
  const access = [
    ["Watch the live terminal", "", true],
    ["Send messages and files", "Through the composer, always labeled", true],
    ["Type into the terminal", "Off: keystrokes can't carry a name", false],
  ] as const;
  const accessRows = access.map(([text, detail, on]) => {
    const row = el("div", `guest-access-row${on ? "" : " guest-access-off"}`), marker = el("span", `guest-access-marker${on ? " is-on" : ""}`);
    marker.textContent = on ? "\u2713" : ""; marker.setAttribute("aria-hidden", "true");
    const label = el("span"); label.append(el("strong", "", text));
    if (detail) label.append(el("span", "guest-field-hint", detail));
    row.setAttribute("aria-label", `${text}. ${detail}. ${on ? "On" : "Off, not available"}`);
    row.append(marker, label); return row;
  });
  const shareRow = el("label", "guest-gram-row"), shareText = el("span");
  shareText.append(el("strong", "", "Share Gram"), el("span", "guest-field-hint", `They also see what ${agentName} sends you from now on, files included, and get notified`));
  const shareGram = el("input", "settings-switch"); shareGram.type = "checkbox"; shareGram.id = "guest-share-gram"; shareGram.setAttribute("role", "switch");
  shareRow.append(shareText, shareGram);
  const create = el("button", "guest-create", "Create invite"); create.type = "submit";
  let loaded = false, creating = false;
  const validate = () => {
    nameHelp.hidden = !name.value.trim() || guestName(name.value) !== null;
    preview.textContent = `${agentName} will see:\n${guestName(name.value) ?? "their-name"} (via HerdrUp): <their message>`;
    ownerHint.textContent = `They'll see “Shared by ${guestOwnerName(owner.value) ?? "you"}”. You can change it in Settings → Shared access.`;
    create.disabled = !loaded || creating || !guestName(name.value) || !(askOwner ? guestOwnerName(owner.value) : savedOwner);
  };
  name.oninput = owner.oninput = validate;
  form.append(ownerSection, field("THEIR NAME", name, nameHelp), preview, section("ACCESS", ...accessRows, shareRow), create);
  content.append(heading, subtitle, form, failure); dialog.append(header, content);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  validate(); dialog.showModal();
  let machineLabel = "";
  void Desk.guestShareDetails(token).then(details => {
    if (!dialog.isConnected) return;
    machineLabel = details.machineLabel;
    agentName = details.agentName;
    heading.textContent = `Share ${agentName}`;
    shareText.lastChild!.textContent = `They also see what ${agentName} sends you from now on, files included, and get notified`;
    subtitle.textContent = `They see only this agent on ${details.machineLabel || "this machine"}. No SSH, no other agents.`;
    loaded = true; validate();
  }).catch(report);
  form.onsubmit = event => {
    event.preventDefault();
    const guest = guestName(name.value), ownerName = askOwner ? guestOwnerName(owner.value) : savedOwner;
    if (!loaded || creating || !guest || !ownerName) return;
    const requestedGram = shareGram.checked;
    creating = true; failure.hidden = true; create.textContent = "Creating…"; validate();
    void (async () => {
      if (askOwner) localStorage.setItem("guest.ownerName", ownerName);
      const created: CreatedGuestInvite = JSON.parse(await Desk.createGuestInvite(token, guest, ownerName, requestedGram));
      if (!dialog.isConnected) return;
      title.textContent = "Invite ready"; heading.textContent = `Invite for ${created.invite.name}`;
      subtitle.textContent = inviteValidity(created.invite);
      form.remove();
      const link = shareableInviteURL(created.web_url);
      const copy = button("Copy link", () => { void Desk.gramCopyText(link).then(() => { if (dialog.isConnected) copy.textContent = "Copied"; }).catch(report); });
      copy.id = "guest-copy-invite";
      const actions = el("div", "guest-invite-actions"); actions.append(copy);
      const details = el("div", "guest-card guest-invite-details");
      const gramState = created.invite.share_gram ? "Shared" : requestedGram ? "Not shared · update Herdr to share Gram" : "Not shared";
      for (const [label, value] of [["Agent", agentName], ["Machine", machineLabel], ["Shown as", `${created.invite.name} (via HerdrUp)`], ["Gram", gramState]]) {
        const row = el("div", "guest-invite-row"), text = el("span", label === "Agent" || label === "Shown as" ? "guest-machine-text" : "", value);
        row.append(el("span", "guest-invite-key", label), text); details.append(row);
      }
      const qr = el("canvas", "guest-invite-qr"); qr.setAttribute("role", "img"); qr.setAttribute("aria-label", `One-use invitation for ${created.invite.name}`);
      content.insertBefore(qr, failure); content.insertBefore(details, failure); content.insertBefore(actions, failure);
      const code = qrcode(0, "M"); code.addData(created.url); code.make();
      const size = code.getModuleCount(); qr.width = qr.height = size + 8;
      const ctx = qr.getContext("2d"); if (!ctx) throw new Error("QR code drawing is unavailable. The invite link is ready to copy.");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, qr.width, qr.height); ctx.fillStyle = "black";
      for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (code.isDark(row, col)) ctx.fillRect(col + 4, row + 4, 1, 1);
    })().catch(report).finally(() => { creating = false; create.textContent = "Create invite"; validate(); });
  };
  return dialog;
}
