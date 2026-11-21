// The host home's account avatar (owner decision 21 Nov, host-status proposal 1; iOS herdrup #780):
// a 32 pt neutral circle at the end of the logo row. Signed out: a person, no dot, unless the
// service answered that it offers no sign-in (nothing to open then). Signed in: the address's initial (a
// person for Apple's private relay or no address) and one dot, done when healthy, waiting while the
// newest machine sync failed. A session the account ended reads as signed out.

export interface AvatarAccount { signedIn: boolean; displayHint?: string; syncFailed?: boolean }

/** `value` is the accessibility value iOS gives the avatar, after its label "HerdrUp account". */
export type Avatar =
 | { shown: false }
 | { shown: true; initial: string | null; dot: "done" | "waiting" | null; value: string };

/** Apple's hidden-address relay: no name to take an initial from. */
const PRIVATE_RELAY = /@privaterelay\.appleid\.com$/i;

/** `offersSignIn`: false only when the account service answered and lists no web sign-in; a
 *  service it couldn't reach keeps the avatar, as the Settings row (HerdrUpAccountPanel) does. */
export function accountAvatar(state: AvatarAccount | null, offersSignIn: boolean): Avatar {
 if (!state?.signedIn) return offersSignIn ? { shown: true, initial: null, dot: null, value: "Signed out" } : { shown: false };
 const hint = state.displayHint?.trim() ?? "";
 const email = hint && !PRIVATE_RELAY.test(hint) ? hint : "";
 const first = email ? [...email][0] : "";
 const initial = first && /\p{L}|\p{N}/u.test(first) ? first.toLocaleUpperCase() : null;
 if (state.syncFailed) return { shown: true, initial, dot: "waiting", value: "Needs attention" };
 return { shown: true, initial, dot: "done", value: email ? `Signed in as ${email}` : "Signed in" };
}
