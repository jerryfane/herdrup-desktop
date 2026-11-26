import type { Guest } from "./settingsGuests";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** An optional field: absent (undefined or null), or of its type. */
const optional = (value: unknown, type: "string" | "boolean") => value == null || typeof value === type;

/** A device removal's confirmation boundary, shared by the desktop and web Desks: settingsGuestList's
 *  JSON decoded to the shares, or null when it isn't a list of shares as targeting reads them. Every
 *  field that decides whether a share admits a device is typed: the share's guest_id (a string),
 *  revoked (boolean), person and fingerprint (strings), and devices (a list of objects with a
 *  string fingerprint and a boolean removed). Optional ones may be absent; a wrongly typed one
 *  (removed: "false", removed: 0) makes the listing unreadable, never another answer. */
export function decodeGuestList(raw: string): Guest[] | null {
  let listing: unknown;
  try { listing = JSON.parse(raw); } catch { return null; }
  const guests = record(listing) ? listing.guests : undefined;
  const valid = Array.isArray(guests) && guests.every(guest => record(guest) && typeof guest.guest_id === "string"
    && optional(guest.revoked, "boolean") && optional(guest.person, "string") && optional(guest.fingerprint, "string")
    && (guest.devices == null || (Array.isArray(guest.devices) && guest.devices.every(device => record(device)
      && typeof device.fingerprint === "string" && optional(device.removed, "boolean")))));
  return valid ? guests as Guest[] : null;
}
