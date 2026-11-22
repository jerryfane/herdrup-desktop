// Unpadded base64url (RFC 4648 §5), as the account service and approve-v1 use it: decoding refuses
// padding and the + and / alphabet rather than guessing (WIRE-PLAN clarification, 22 Nov).

const ALPHABET = /^[A-Za-z0-9_-]*$/;

export function toB64url(bytes: Uint8Array): string {
 let binary = "";
 for (const byte of bytes) binary += String.fromCharCode(byte);
 return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes text stands for, or null when it isn't unpadded base64url (or, with length, isn't
 *  that many bytes). */
export function fromB64url(text: unknown, length?: number): Uint8Array | null {
 if (typeof text !== "string" || !ALPHABET.test(text) || text.length % 4 === 1) return null;
 let binary: string;
 try { binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4)); }
 catch { return null; }
 const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
 // A non-canonical last character (spare bits set) decodes, but isn't what an encoder makes.
 if (toB64url(bytes) !== text) return null;
 return length === undefined || bytes.length === length ? bytes : null;
}
