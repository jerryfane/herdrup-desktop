import { expect, test } from "bun:test";
import { connectionOfView, guestPausedPage, guestSendFailure, isGuestPaused } from "../src/guestPaused";

test("paused share: NOT RUNNING, centre message, composer placeholder (GuestPaneView.swift:406-409, 497-500, 587-596)", () => {
 expect(guestPausedPage("paused", "docs")).toEqual({
  pill: "NOT RUNNING",
  center: { icon: "pause.fill", title: "docs isn't running", detail: "The shared agent isn't available in this terminal. Your messages and files so far are still in the transcript." },
  placeholder: "Agent unavailable",
 });
});

test("running, reconnecting, offline and lost are not paused", () => {
 for (const availability of [undefined, "", "reconnecting", "offline", "lost"]) expect(guestPausedPage(availability, "docs")).toBeNull();
});

test("a send refused with guest_paused says the agent isn't running (GuestPaneView.swift:918-920)", () => {
 const refused = "herdr: guest_paused: the owner paused sharing";
 expect(isGuestPaused(refused)).toBe(true);
 expect(guestSendFailure(refused, "docs")).toBe("docs isn't running, so it wasn't sent.");
 expect(guestSendFailure("herdr: guest_forbidden: no", "docs")).toBeNull();
});

test("a web owner's owner_paused reads as paused, as guest_paused does", () => {
 expect(isGuestPaused("pane.stream ended: herdr: owner_paused: no running agent")).toBe(true);
 expect(isGuestPaused("herdr: owner_forbidden: not in this scope")).toBe(false);
});

test("a published connection applies to a guest's agent page and to a web owner's on that machine, no other", () => {
 const access = { endpoint: { hostID: "H" }, guestID: "g1" };
 expect(connectionOfView("guest:H/g1", access)).toBe(true);
 expect(connectionOfView("owner:H", access)).toBe(true);
 expect(connectionOfView("owner:other", access)).toBe(false);
 expect(connectionOfView("guest:H/g2", access)).toBe(false);
 expect(connectionOfView("owner:H", undefined)).toBe(false);
});
