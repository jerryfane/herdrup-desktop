import type { Guest } from "./settingsGuests";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** guest.list's `guests` when it is a list of shares as the owner pages read them: each an object
 *  with its guest_id, its devices absent or a list of objects with a fingerprint. Anything else is
 *  null: a listing that isn't one is unreadable, never an empty list. */
export function listedGuests(guests: unknown): Guest[] | null {
  const valid = Array.isArray(guests) && guests.every(guest => record(guest) && typeof guest.guest_id === "string"
    && (guest.devices == null || (Array.isArray(guest.devices) && guest.devices.every(device => record(device) && typeof device.fingerprint === "string"))));
  return valid ? guests as Guest[] : null;
}
