// Which page a load of /web/ runs: the guest page (web/main.ts) or the owner's
// desktop shell (src/main.ts). One per load; switching is a reload.

/** sessionStorage: the owner screen's "Use a guest invitation instead", for the next load only. */
export const GUEST_INSTEAD_KEY = "herdrup.web.guestInstead";

/** What this load decided, for the page it chose: whether the person asked for the guest page
 *  while signed in (the guest page then doesn't send them back to the owner's). */
export const boot = { guestInstead: false };

export interface BootFacts {
 /** The address carries an invite (/web/#…). */
 fragment: boolean;
 guestInstead: boolean;
 /** This browser keeps a guest grant. */
 grant(): Promise<boolean>;
 /** The account service has a session for this browser. */
 signedIn(): Promise<boolean>;
}

/** An invite in the address, or a kept grant, is the guest's; else a signed-in browser is an
 *  owner's, unless it asked for the guest page. A fact that can't be read counts as absent. */
export async function choosePage(f: BootFacts): Promise<"guest" | "owner"> {
 if (f.fragment || f.guestInstead) return "guest";
 if (await f.grant().catch(() => false)) return "guest";
 return await f.signedIn().catch(() => false) ? "owner" : "guest";
}
