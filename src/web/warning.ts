// The desktop's native warning (mygo.Dialog.Message, MessageWarning) as an in-page alert: Go shows
// a failed agent action (AlertAgentFailure) and a folder save that failed (alertGroups) this way,
// title and detail apart, dismissed with OK. It takes the row menu's confirmation look
// (agentActions.ts confirmAction).

export function showWarning(title: string, detail: string): void {
 const dialog = document.createElement("dialog");
 dialog.className = "folder-naming agent-confirm";
 dialog.setAttribute("role", "alertdialog");
 const heading = document.createElement("h2");
 heading.textContent = title;
 const text = document.createElement("p");
 text.textContent = detail;
 const buttons = document.createElement("div");
 buttons.className = "buttons";
 const ok = document.createElement("button");
 ok.type = "button"; ok.textContent = "OK";
 ok.onclick = () => dialog.close();
 buttons.append(ok);
 dialog.append(heading, text, buttons);
 dialog.addEventListener("close", () => dialog.remove(), { once: true });
 document.body.append(dialog);
 dialog.showModal();
 ok.focus();
}
