// Shared table presentation helpers for Chat (`chatMarkdown.ts`) and Gram (`gramMarkdown.ts`).

export const CHAT_OK_COLOR = "#7fc89a";

export interface MarkdownTableClasses {
  scroller: string;
  frame: string;
  number: string;
  gain: string;
}

export function prepareMarkdownTables(root: ParentNode, classes: MarkdownTableClasses): void {
  for (const table of root.querySelectorAll("table")) {
    const scroller = document.createElement("div");
    scroller.className = classes.scroller;
    const frame = document.createElement("div");
    frame.className = classes.frame;
    const columns = Math.max(1, ...[...table.rows].map((row) => row.cells.length));
    frame.style.setProperty("--table-columns", String(columns));
    // ChatView.swift ChatStyle.ok for gains; not a generated design token (as the plan card).
    frame.style.setProperty("--chat-ok", CHAT_OK_COLOR);
    table.replaceWith(scroller);
    frame.append(table);
    scroller.append(frame);
    for (const cell of table.querySelectorAll("td")) {
      const value = cell.textContent?.trim() ?? "";
      if (/^[0-9+\-−$]/.test(value) && /[0-9]/.test(value)) {
        cell.classList.add(classes.number, ...(value.startsWith("+") ? [classes.gain] : []));
      }
    }
  }
}
