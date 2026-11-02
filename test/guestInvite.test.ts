import { expect, test } from "bun:test";
import { guestName, guestOwnerName, shareableInviteURL } from "../src/guestInviteModel";

test("invitation names preserve ASCII guest limits and Unicode owner graphemes", () => {
  expect(guestName(" alex.smith-2_ ")).toBe("alex.smith-2_");
  expect(guestName("a".repeat(32))).toBe("a".repeat(32));
  expect(guestName("a".repeat(33))).toBeNull();
  expect(guestName("_alex")).toBeNull();
  expect(guestName("al éx")).toBeNull();
  const accented = "e\u0301".repeat(64);
  expect(guestOwnerName(` ${accented} `)).toBe(accented);
  expect(guestOwnerName(accented + "x")).toBeNull();
  expect(guestOwnerName(" \n ")).toBeNull();
});

test("legacy invitation links move only eligible fragments into the relay path", () => {
  expect(shareableInviteURL("https://relay.example/team/i#Abc_12-xy")).toBe("https://relay.example/team/i/Abc_12-xy");
  expect(shareableInviteURL("https://relay.example/i/Abc_12-xy")).toBe("https://relay.example/i/Abc_12-xy");
  expect(shareableInviteURL("https://user@relay.example/i#payload")).toBe("https://user@relay.example/i#payload");
  expect(shareableInviteURL("https://relay.example/i?#payload")).toBe("https://relay.example/i?#payload");
  expect(shareableInviteURL("https://relay.example/elsewhere#payload")).toBe("https://relay.example/elsewhere#payload");
  expect(shareableInviteURL("herdrup://guest-invite#payload")).toBe("herdrup://guest-invite#payload");
});
