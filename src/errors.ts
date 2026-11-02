/** An error as a person reads it: a Go call's message without the bridge's "CallError: " (mygo
 *  runtime's Error name), as herdrup shows an error's own text (e.g. "send failed: \(error)"). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
