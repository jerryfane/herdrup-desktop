import { expect, test } from "bun:test";
import { updateSuggestion } from "../src/settingsUpdates";

type State = NonNullable<Parameters<typeof updateSuggestion>[0]>;
const state = (fields: Partial<State>): State => ({
  known: true, version: "0.9.5", flow: "idle", code: "", message: "", forbidden: false, restartLater: false, missing: [], ...fields,
});

// The ping in herdrup's Settings reference fixtures: a herdr from before server_update.
test("a herdr that predates server_update asks for the one-time update", () => {
  expect(updateSuggestion(state({ capabilities: {} }), "Mac")).toEqual({
    title: "herdr needs a one-time update",
    subtitle: "This version can't update itself from the app.",
  });
});

// What fakeherdr -current serves: ServerRequirement.current met, nothing newer published.
test("a current herdr with no newer build suggests nothing", () => {
  const capabilities = { server_update: true, agent_groups: true, agent_avatar: true, agent_answer: true };
  const check = { running: { version: "0.9.5", commit_time: 1793108998 }, update_available: false, mode: "live" };
  expect(updateSuggestion(state({ capabilities, check }), "Mac")).toBeNull();
});
