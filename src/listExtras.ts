// Pure rules for the agent card's extras, the session pills and the
// needs-you pill, kept free of the DOM so bun tests them.

/** herdrup compactTimeInState (Sources/HerdrKit/AgentList.swift): whole
 * minutes under an hour, hours under a day, then days; nothing when the
 * status time is unknown or in the future. */
export function timeInState(sinceUnixMs: number | undefined, nowUnixMs: number): string | null {
  if (sinceUnixMs === undefined || sinceUnixMs === null || nowUnixMs < sinceUnixMs) return null;
  const seconds = Math.floor((nowUnixMs - sinceUnixMs) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** herdrup accountDisplayLabel: the account's label when the id is known,
 * else the raw id, so an agent on an unexpected account is never silent. */
export function accountLabel(accountID: string | undefined, labels: Record<string, string>): string | null {
  if (!accountID) return null;
  return (Object.hasOwn(labels, accountID) ? labels[accountID] : undefined) ?? accountID;
}

/** NeedsYouPill.countText. */
export function needsYouText(count: number): string {
  return count === 1 ? "1 agent needs you" : `${count} agents need you`;
}

/** NeedsYouSight.sample: the waiting rows are out of sight once the list
 * has scrolled to the bottom of the needs-you section, or past 1 pt when
 * that section has not been laid out. */
export function waitingOutOfSight(scrollTop: number, waitingBottom: number | null): boolean {
  return waitingBottom === null ? scrollTop > 1 : scrollTop >= waitingBottom;
}
