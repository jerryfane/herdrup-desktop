// What this browser is, from its user agent: the account's name for it, and the parse the owner
// screen tells browser kinds by.

/** What this browser is called on the account's devices and on the approval sheet: "Chrome on
 *  macOS", from the user agent; "Web browser" when it can't tell. */
export function browserDeviceName(ua: string): string {
 return deviceLabel(parseUserAgent(ua));
}

/** The account's name for a parsed browser ("Chrome on macOS"). */
export function deviceLabel({ browser, os }: { browser: string; os: string }): string {
 if (browser && os) return `${browser} on ${os}`;
 return browser || (os ? `Browser on ${os}` : "Web browser");
}

/** The browser and OS a user agent names ("" when it names none). */
export function parseUserAgent(ua: string): { browser: string; os: string } {
 const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
 const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS"
  : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
 return { browser, os };
}
