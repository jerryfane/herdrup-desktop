/** The sidebar search's test (herdrup visibleSections): the query appears,
 * ignoring case, inside one of the row's match strings (Row.match: display
 * name, raw name, terminal title). An empty query matches everything. */
export function matches(match: readonly string[], query: string): boolean {
  if (query === "") return true;
  const q = query.toLocaleLowerCase();
  return match.some((s) => s.toLocaleLowerCase().includes(q));
}
