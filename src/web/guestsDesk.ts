// Guests of the owner link's machine: Settings → Shared access (desk_settings_guests.go) and the
// agent page's "Share with someone" invite (desk_guest_invite.go), over herdr's guest.* methods.
// herdr serves them to an owner's browser under a terminal-scope grant only (herdr#510), and only
// for its own machine: a `machine` param (a saved SSH machine) is refused, so none is ever sent.

import type { Desk as GoDesk } from "../mygo";
import { errorText } from "../errors";
import { HerdrAPIError } from "../webguest/errors";
import { ErrUnsupported } from "./engine";
import { currentOwnerLink, ownerCall, settingsCall, settingsLink, settingsScope } from "./ownerLink";
import { agentView } from "./view";

type DeskFns = typeof GoDesk;

/** desk_settings_guests.go's missingFeature: a host without guest.* (it predates them). */
export function guestsMissing(error: unknown): boolean {
 return error instanceof ErrUnsupported || (error instanceof HerdrAPIError &&
  (error.code === "unsupported" || (error.code === "invalid_request" && error.apiMessage.includes("unknown variant"))));
}

/** Settings' guests of another machine (Go's saved SSH machines): the browser has none to reach. */
function thisMachineOnly(machine: string) {
 if (machine !== "") throw new Error("Shared access of other machines isn't available in the browser.");
}

export const guestsDesk = {
 /** SettingsGuestMachine: the guests and invites, then the activity log; a log that can't be read
  *  is told apart from an empty one. */
 async settingsGuestMachine(token: string, machine: string): Promise<string> {
  const scope = settingsScope(token);
  thisMachineOnly(machine);
  const result: { listing?: unknown; entries: unknown[] | null; error?: string; auditError?: string; missingFeature?: boolean } = { entries: null };
  try {
   result.listing = await settingsCall(scope, "guest.list", {}, "guest_list");
  } catch (error) {
   result.error = errorText(error);
   if (guestsMissing(error)) result.missingFeature = true;
  }
  if (result.listing !== undefined) {
   try {
    result.entries = (await settingsCall<{ entries: unknown[] }>(scope, "guest.audit", { limit: 100 }, "guest_audit")).entries;
   } catch (error) { result.auditError = errorText(error); }
  }
  settingsLink(token);
  return JSON.stringify(result);
 },

 async setGuestGramSharing(token: string, machine: string, guestID: string, share: boolean): Promise<void> {
  const scope = settingsScope(token);
  thisMachineOnly(machine);
  await settingsCall(scope, "guest.update", { guest_id: guestID, share_gram: share }, "guest_updated");
 },

 async revokeGuestAccess(token: string, machine: string, id: string, invite: boolean): Promise<void> {
  const scope = settingsScope(token);
  thisMachineOnly(machine);
  await settingsCall(scope, "guest.revoke", invite ? { invite_id: id } : { guest_id: id }, "guest_revoked");
 },

 /** RevokeGuestPerson: every share of one person on this machine (guest.revoke {person}). */
 async revokeGuestPerson(token: string, machine: string, person: string): Promise<void> {
  const scope = settingsScope(token);
  thisMachineOnly(machine);
  if (person === "") throw new Error("no person to remove");
  await settingsCall(scope, "guest.revoke", { person }, "guest_revoked");
 },

 /** RemoveGuestDevice: one device (its fingerprint) off one account-bound share (guest.remove_device). */
 async removeGuestDevice(token: string, machine: string, guestID: string, deviceID: string): Promise<void> {
  const scope = settingsScope(token);
  thisMachineOnly(machine);
  await settingsCall(scope, "guest.remove_device", { guest_id: guestID, fingerprint: deviceID }, "guest_device_removed");
 },

 /** CreateGuestInvite: an invite to the agent the view shows, on the link's machine. Its guests see
  *  the machine as the view's share details name it (desk_guest_invite.go): a federated peer's
  *  agent by herdr's machine_label for it (else the peer's id), the link's own agents by the label
  *  sealed in the browser's approval (link.machine.label). A lost answer is not retried: herdr may
  *  already have made the invite. */
 async createGuestInvite(token: string, name: string, ownerName: string, shareGram: boolean): Promise<string> {
  const view = agentView(token);
  const link = currentOwnerLink();
  if (link === null) throw new Error("not connected");
  const created = await ownerCall("guest.invite.create", {
   target: view.paneID, machine_label: view.share.details.machineLabel, name: name.trim(), owner_name: ownerName.trim(), ...(shareGram ? { share_gram: true } : {}),
  }, "guest_invite_created", { signal: view.signal, link });
  return JSON.stringify(created);
 },
} satisfies Partial<DeskFns>;
