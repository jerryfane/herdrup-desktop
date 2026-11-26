/** An error as a person reads it: a Go call's message without the bridge's "CallError: " (mygo
 *  runtime's Error name), as herdrup shows an error's own text (e.g. "send failed: \(error)"). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The code field of the first herdr error envelope in text, or null without one: both Desks
 *  word a herdr error "herdr: <code>: <message>" (Go bridge.APIError, web HerdrAPIError). */
export function herdrCode(text: string): string | null {
 const marker = /(?:^|[\s:])herdr: /.exec(text);
 if (marker === null) return null;
 const field = text.slice(marker.index + marker[0].length);
 const end = field.indexOf(": ");
 return end < 0 ? field : field.slice(0, end);
}
