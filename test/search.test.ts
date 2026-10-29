import { expect, test } from "bun:test";
import { matches } from "../src/search";

const federated = ["Studio Mac/render", "studio/render", "π > baking lights"];

test("search finds a query inside any one match string, ignoring case", () => {
  expect(matches(federated, "studio mac")).toBe(true); // display name
  expect(matches(federated, "STUDIO/")).toBe(true); // raw name with the alias
  expect(matches(federated, "baking")).toBe(true); // terminal title
});

test("search does not match across strings or partial words that are absent", () => {
  // "render π" only exists if two strings were joined.
  expect(matches(federated, "render π")).toBe(false);
  expect(matches(federated, "deploy")).toBe(false);
});

test("an empty query matches every row, even one with nothing to match", () => {
  expect(matches([], "")).toBe(true);
  expect(matches([], "a")).toBe(false);
});
