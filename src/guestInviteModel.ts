export function guestName(raw: string): string | null {
  const name = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name) ? name : null;
}

const ownerCharacters = new Intl.Segmenter();
export function guestOwnerName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  let count = 0;
  for (const _ of ownerCharacters.segment(name)) if (++count > 64) return null;
  return name;
}

// GuestInvite.pathFormWebLink: Messages can split the old fragment form.
export function shareableInviteURL(text: string): string {
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.href.split("#", 1)[0]!.includes("?") || !url.pathname.endsWith("/i") || url.hash.length < 2) return text;
    url.pathname += "/" + url.hash.slice(1); url.hash = "";
    return url.href;
  } catch { return text; }
}

export interface CreatedGuestInvite {
  invite: { invite_id: string; name: string; created_ms?: number; expires_ms?: number; share_gram?: boolean };
  url: string;
  web_url: string;
}
export function inviteValidity(invite: CreatedGuestInvite["invite"]): string {
  if (invite.created_ms === undefined || invite.expires_ms === undefined || invite.expires_ms <= invite.created_ms) return "Works once";
  const hours = Math.round((invite.expires_ms - invite.created_ms) / 3600000);
  return hours >= 1 ? `Works once · expires in ${hours} h` : "Works once · expires within the hour";
}
