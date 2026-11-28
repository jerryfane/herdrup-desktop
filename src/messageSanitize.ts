// Shared DOMPurify HTML sanitization policy for rendered Markdown messages in Chat
// (`chatMarkdown.ts`) and Gram (`gramMarkdown.ts`).
export const MESSAGE_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "form", "input"],
  FORBID_ATTR: ["style"],
};
