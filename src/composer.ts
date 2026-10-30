// Move the real textarea, not a copy: selection, undo, draft updates and send
// acknowledgements keep a single owner while the writing surface is expanded.
let active: (() => void) | null = null;
export function closeWriter() { active?.(); }
export function expandWriter(input: HTMLTextAreaElement, title: string) {
  if (active) { active(); }
  const marker = document.createComment("composer location");
  input.before(marker);
  const dialog = document.createElement("dialog");
  dialog.className = "writer";
  const heading = document.createElement("h2"); heading.textContent = title;
  const done = document.createElement("button"); done.type = "button"; done.textContent = "Done writing";
  const note = document.createElement("p"); note.textContent = "Your draft is kept as you type. Done writing returns it to the composer without sending.";
  const count = document.createElement("span");
  const update = () => { count.textContent = `${input.value.length.toLocaleString()} characters`; };
  const footer = document.createElement("footer"); footer.append(count, done);
  dialog.append(heading, note, input, footer);
  document.body.append(dialog);
  const start = input.selectionStart, end = input.selectionEnd;
  const finish = () => {
    if (!dialog.isConnected) return;
    input.removeEventListener("input", update);
    marker.replaceWith(input);
    dialog.close(); dialog.remove(); active = null;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  active = finish;
  done.onclick = finish;
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  // Writing mode never sends accidentally via the compact composer's shortcut.
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  input.addEventListener("input", update); update();
  dialog.showModal(); input.focus(); input.setSelectionRange(start, end);
}
