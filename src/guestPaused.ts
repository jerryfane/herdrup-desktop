// A shared agent that isn't running (herdrup GuestPaneView availability .paused,
// App/GuestPaneView.swift:737-753): the host lists no shared agent, or lists it with
// guest_running false (desk_guest.go runGuest publishes availability "paused"), or refused a
// call with guest_paused (apply(error), :765-780).

/** What a guest's agent page shows for the share's availability; null while the agent runs. */
export interface GuestPausedPage {
 /** statusPill's neutral label (GuestPaneView.swift:406-409). */
 pill: string;
 /** centerMessage over the terminal area, which is unmounted meanwhile (:441-445, :497-500). */
 center: { icon: string; title: string; detail: string };
 /** The composer's placeholder (:587-596); canCompose is false (:515). */
 placeholder: string;
}

/** GuestConnection.availability is "paused" (Go); anything else leaves the page as it is. */
export function guestPausedPage(availability: string | undefined, agent: string): GuestPausedPage | null {
 if (availability !== "paused") return null;
 return {
  pill: "NOT RUNNING",
  center: { icon: "pause.fill", title: `${agent} isn't running`, detail: "The shared agent isn't available in this terminal. Your messages and files so far are still in the transcript." },
  placeholder: "Agent unavailable",
 };
}

/** herdr's guest_paused refusal, as Go words a herdr error ("herdr: guest_paused: …"). */
export function isGuestPaused(message: string): boolean {
 return message.includes("guest_paused");
}

/** failureNote for a send the host refused while paused (GuestPaneView.swift:918-920). */
export function guestSendFailure(message: string, agent: string): string | null {
 return isGuestPaused(message) ? `${agent} isn't running, so it wasn't sent.` : null;
}
