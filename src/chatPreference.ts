// App/ChatPreference.swift: the stored default is separate from a manual
// per-agent choice, which lives only for this app session.
export type ChatMode = "chat" | "terminal";
export function defaultChatMode(): ChatMode {
  try { return localStorage.getItem("chat.ompOpensIn") === "terminal" ? "terminal" : "chat"; }
  catch { return "chat"; }
}
export function changeDefaultChatMode(mode: ChatMode) {
  localStorage.setItem("chat.ompOpensIn", mode);
}
