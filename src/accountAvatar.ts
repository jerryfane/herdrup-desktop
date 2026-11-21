// The host home's account avatar (owner decision 21 Nov, host-status proposal 1): a 32 pt
// neutral circle at the end of the logo row. Signed out: a person, no dot, and only while the
// service offers sign-in (nothing to open otherwise). Signed in: the address's initial (a person
// for Apple's private relay or no address) and one dot, done when healthy, waiting while the
// newest machine sync failed. A session the account ended reads as signed out.

export interface AvatarAccount { signedIn: boolean; displayHint?: string; syncFailed?: boolean }

export type Avatar =
 | { shown: false }
 | { shown: true; initial: string | null; dot: "done" | "waiting" | null; label: string };

/** Apple's hidden-address relay: no name to take an initial from. */
const PRIVATE_RELAY = /@privaterelay\.appleid\.com$/i;

export function accountAvatar(state: AvatarAccount | null, providers: readonly string[]): Avatar {
 if (!state?.signedIn) return providers.length ? { shown: true, initial: null, dot: null, label: "Sign in to your HerdrUp account" } : { shown: false };
 const hint = state.displayHint?.trim() ?? "";
 const first = hint && !PRIVATE_RELAY.test(hint) ? [...hint][0] : "";
 const initial = first && /\p{L}|\p{N}/u.test(first) ? first.toLocaleUpperCase() : null;
 const who = hint && initial ? `, signed in as ${hint}` : ", signed in";
 return state.syncFailed
  ? { shown: true, initial, dot: "waiting", label: `HerdrUp account${who}. Sync needs attention` }
  : { shown: true, initial, dot: "done", label: `HerdrUp account${who}` };
}
