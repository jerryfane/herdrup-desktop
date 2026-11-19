// App/ChatPreference.swift: the stored default is separate from a manual
// per-agent choice, which lives only for this app session. Topics opens only
// where the agent offers topics (topicsModel.ts resolvedMode); elsewhere a
// Topics default opens Chat, so agents without topics look as before.
export type ChatMode = "topics" | "chat" | "terminal";
export function chatModeOf(value: string | null): ChatMode {
  return value === "terminal" || value === "topics" ? value : "chat";
}
export function defaultChatMode(): ChatMode {
  try { return chatModeOf(localStorage.getItem("chat.ompOpensIn")); }
  catch { return "chat"; }
}
export function changeDefaultChatMode(mode: ChatMode) {
  localStorage.setItem("chat.ompOpensIn", mode);
}
