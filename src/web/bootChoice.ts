// Which page a load of /web/ runs: the guest page (web/main.ts) or the owner's
// desktop shell (src/main.ts). One per load; switching is a reload.
//
// The marks a tab keeps across its own reloads (sessionStorage), and their lifecycle. A mark is
// cleared only when the page it names has loaded (and so has its say), or when the person changes
// course:
// - GUEST_INSTEAD_KEY, the guest's way: set by the person (chooseGuest: the boot card's or the
//   owner screen's "Use a guest invitation instead"); cleared once the guest page has loaded.
// - SIGNED_IN_FOUND_KEY, the owner's way: set by the guest page when it finds this browser signed
//   in (keepSignedInFound, with the reload it asks for); read by every load, which then opens the
//   owner's page with no account lookup; cleared once the owner's page has loaded, or by the
//   person taking the guest's way. So a load that fails to fetch the owner's code still knows,
//   after the recovery reload, where it was going, and asks no lookup that could time out again.
//   The destination saying no is its own exit: an owner's page whose first refresh says there is
//   no session (the handoff was stale: "no-session", ownerSession.ts) starts over with the mark
//   already spent, so that load asks the account service and lands on the signed-out welcome.
// - LOAD_RELOADED_KEY, the recovery guard: set by a load whose page's code didn't load, as it
//   reloads (afterLoadFailure: once per attempt); cleared once a page has loaded, or by the person
//   starting again (the error card's Reload, newAttempt) or taking the guest's way.

/** sessionStorage: the guest page was asked for while signed in. */
export const GUEST_INSTEAD_KEY = "herdrup.web.guestInstead";
/** sessionStorage: this attempt to load the page has already reloaded once because its code
 *  didn't load. */
export const LOAD_RELOADED_KEY = "herdrup.web.loadReloaded";
/** sessionStorage: the guest page found this browser signed in after its load chose it (the
 *  account lookup answered after its wait, or another tab signed in): loads are the owner's, with
 *  no lookup, until the owner's page has loaded. */
export const SIGNED_IN_FOUND_KEY = "herdrup.web.signedInFound";

/** What this load decided, for the page it chose: whether the person asked for the guest page
 *  while signed in (the guest page then doesn't send them back to the owner's). */
export const boot = { guestInstead: false };

/** What the guest page's first screen depends on: the guest's way chosen at boot (boot) or on the
 *  sign-in (guestChosen), whether the welcome is a plain one (start.ts plainWelcome), the session,
 *  and the sign-in providers the account service offers. */
export interface FirstScreenFacts { bootGuest: boolean; guestChosen: boolean; plain: boolean; signedIn: boolean; providers: number }

/** Whether the guest page shows the desktop's sign-in first: a signed-out plain visit while the
 *  service offers sign-in. The guest's way chosen at boot counts as chosen already, so it reaches
 *  the invite's words with that one click (#513). */
export function signInFirst(f: FirstScreenFacts): boolean {
 return f.plain && !f.bootGuest && !f.guestChosen && !f.signedIn && f.providers > 0;
}

export interface BootFacts {
 /** The address carries an invite (/web/#…), or one waits in this tab for its sign-in's return
  *  (start.ts PENDING_BIND_KEY), which comes back to a plain /web/?account=1. */
 fragment: boolean;
 guestInstead: boolean;
 /** The guest page found a session (SIGNED_IN_FOUND_KEY): no lookup is waited for. */
 signedInFound: boolean;
 /** This browser keeps a guest grant. */
 grant(): Promise<boolean>;
 /** The account service has a session for this browser (a lookup, bounded). */
 signedIn(): Promise<boolean>;
}

/** An invite in the address, or a kept grant, is the guest's; else a signed-in browser is an
 *  owner's, unless it asked for the guest page: one the last load found signed in at once, else as
 *  the lookup says. A fact that can't be read counts as absent. */
export async function choosePage(f: BootFacts): Promise<"guest" | "owner"> {
 if (f.fragment || f.guestInstead) return "guest";
 if (await f.grant().catch(() => false)) return "guest";
 if (f.signedInFound) return "owner";
 return await f.signedIn().catch(() => false) ? "owner" : "guest";
}

/** How long a load waits for the account service to say whether this browser is signed in. */
export const ACCOUNT_LOOKUP_MS = 6_000;

/** Whether the account lookup found a session, bounded: false when it fails, and false as soon as
 *  one of giveUp settles first (the wait's end, or the person taking the guest's way). A stalled
 *  service never strands the page; the lookup goes on and a later sign-in still counts there. */
export function signedInBefore(lookup: Promise<boolean>, ...giveUp: Promise<unknown>[]): Promise<boolean> {
 return Promise.race([lookup.catch(() => false), ...giveUp.map(p => p.then(() => false, () => false))]);
}

/** The sessionStorage calls the marks use. */
export interface SessionMarks { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** What a load of /web/ keeps across its own reloads (sessionStorage, this tab; see the top). */
export interface BootMarks {
 /** The guest page was asked for while signed in. */
 guestInstead(): boolean;
 /** The person takes the guest's way: it holds through a recovery reload, and the owner's way a
  *  found session set is dropped, as is the recovery guard (a new course). */
 chooseGuest(): void;
 /** The page's code didn't load (a network drop, or a deploy that replaced the hashed files this
  *  index names: Vite's advice for its preload errors is a reload, which fetches the new index).
  *  "reload" once per attempt, marked before it is returned; then, however long each try took,
  *  "explain", leaving the next try to the person. With no storage there is no mark: "explain". */
 afterLoadFailure(): "reload" | "explain";
 /** The person starts a new attempt (the error card's Reload): it may reload once again. */
 newAttempt(): void;
 /** The page loaded: the attempt is over, and the way to it (guest's or owner's) is spent. */
 loaded(page: "guest" | "owner"): void;
 /** The guest page found this browser signed in: marks the owner's way, true once it is kept
  *  (false with no storage: a reload would ask again, and could land on the guest page again). */
 keepSignedInFound(): boolean;
 /** Whether the owner's way is marked (keepSignedInFound); reading it doesn't spend it. */
 signedInFound(): boolean;
}

export function bootMarks(storage: () => SessionMarks = () => sessionStorage): BootMarks {
 const has = (key: string) => { try { return storage().getItem(key) !== null; } catch { return false; } };
 const mark = (key: string, on: boolean) => {
  try { if (on) storage().setItem(key, "1"); else storage().removeItem(key); return true; } catch { return false; }
 };
 return {
  guestInstead: () => has(GUEST_INSTEAD_KEY),
  chooseGuest() { mark(GUEST_INSTEAD_KEY, true); mark(SIGNED_IN_FOUND_KEY, false); mark(LOAD_RELOADED_KEY, false); },
  afterLoadFailure() { return !has(LOAD_RELOADED_KEY) && mark(LOAD_RELOADED_KEY, true) ? "reload" : "explain"; },
  newAttempt() { mark(LOAD_RELOADED_KEY, false); },
  loaded(page) {
   mark(LOAD_RELOADED_KEY, false);
   mark(page === "guest" ? GUEST_INSTEAD_KEY : SIGNED_IN_FOUND_KEY, false);
  },
  keepSignedInFound() { return mark(SIGNED_IN_FOUND_KEY, true); },
  signedInFound: () => has(SIGNED_IN_FOUND_KEY),
 };
}

/** One load of /web/, as boot.ts runs it: the page chosen (choosePage, with the owner's way this tab
 *  keeps), then its code (load). "loaded" once it ran; a page whose code didn't load reloads once
 *  per attempt ("reload"), then "explain". report gets why it didn't load. */
export async function loadPage(marks: BootMarks, facts: Omit<BootFacts, "signedInFound">, load: (page: "guest" | "owner") => Promise<void>,
 report: (error: unknown) => void): Promise<"loaded" | "reload" | "explain"> {
 try {
  const page = await choosePage({ ...facts, signedInFound: marks.signedInFound() });
  await load(page);
  marks.loaded(page);
  return "loaded";
 } catch (error) {
  report(error);
  return marks.afterLoadFailure();
 }
}
