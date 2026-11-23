import { afterAll, expect, test } from "bun:test";
import { boardShown, definitiveAvatarFailure, forgetFailedPhotos, knownPhoto, loadPhoto, photoAsksOut } from "../src/avatars";
import { Desk, type Avatar } from "../src/mygo";
import { closed, HerdrAPIError, hostOffline, other, ownerRefusal, rateLimited, relayRefused, revoked, timedOut } from "../src/webguest/errors";
import { checkTag, ErrUnsupported } from "../src/web/engine";
import { avatarDataURL } from "../src/web/desk";
import { closeError } from "../src/webguest/transport";

// Desk.avatarImage answers from this queue, one reply per call.
const replies: Array<() => Promise<string>> = [];
let calls = 0;
const avatarImage = Desk.avatarImage;
Desk.avatarImage = () => {
  calls++;
  return (replies.shift() ?? (() => Promise.reject(new Error("no reply"))))();
};
afterAll(() => {
  Desk.avatarImage = avatarImage;
});

const sha = "a".repeat(64);
const avatar = { kind: "image", target: "t1", sha256: sha } as Avatar;
const notFound = () => Promise.reject(new HerdrAPIError("not_found", "no avatar", {}));
/** A desktop error as the page gets it: the Go error's text. */
const goError = (message: string) => Object.assign(new Error(message), { name: "CallError" });

/** What a failed ask threw, or the error itself. */
const thrown = async (f: () => unknown) => {
  try { await f(); } catch (error) { return error; }
  throw new Error("did not throw");
};

test("herdr's answers about a photo are definitive; a failure on the way to herdr is not", async () => {
  const text = btoa("not a picture");
  const definitive = [
    // herdr refused it, on the web and on the desktop (bridge/client.go APIError).
    new HerdrAPIError("not_found", "no avatar", {}),
    new HerdrAPIError("not_found", "", {}),
    goError("herdr: not_found: no avatar"),
    goError("agent.avatar.get: herdr: invalid_params: bad sha256"),
    // A herdr without agent_avatar.
    new ErrUnsupported("agent.avatar.get", "agent_avatar", "0.9.0"),
    new ErrUnsupported("agent.avatar.get", "", ""),
    goError("herdr 0.9.0 does not support agent.avatar.get (no agent_avatar capability)"),
    // A reply that is not the photo, or not its bytes.
    await thrown(() => checkTag("agent.avatar.get", { type: "pong" }, "agent_avatar_image")),
    await thrown(() => avatarDataURL(text, "0".repeat(64))),
    await thrown(() => avatarDataURL("%%", "0".repeat(64))),
    goError("avatar is text/plain; charset=utf-8, not an image"),
    goError("avatar is not base64: illegal base64 data at input byte 0"),
    goError("avatar bytes do not match sha256 " + sha),
    goError(`invalid avatar sha256 "nope"`),
    // The desktop's own remembered refusal.
    goError("avatar photo unavailable"),
  ];
  const transient = [
    hostOffline(), closed(), timedOut(), rateLimited(), relayRefused(), revoked(), ownerRefusal("owner_busy"),
    closeError(4503, "host_offline"), closeError(1006, ""), other("The shared connection closed (code 1011)."),
    new Error("not connected"), goError("not connected"), new DOMException("The operation was aborted.", "AbortError"),
    goError("ssh: connection lost"), goError("context deadline exceeded"), goError("EOF"),
  ];
  for (const e of definitive) expect([String(e), definitiveAvatarFailure(e)]).toEqual([String(e), true]);
  for (const e of transient) expect([String(e), definitiveAvatarFailure(e)]).toEqual([String(e), false]);
});

// #36: herdr's refusal is drawn as the initial tile for that connection only;
// once reconnected the photo is asked for again.
test("a photo herdr refused is asked for again on a new connection", async () => {
  replies.push(notFound);
  expect(await loadPhoto(avatar)).toBeNull();
  expect(knownPhoto(avatar)).toBeNull();
  // Same connection: remembered, not fetched again.
  expect(await loadPhoto(avatar)).toBeNull();
  expect(calls).toBe(1);

  forgetFailedPhotos();
  expect(knownPhoto(avatar)).toBeUndefined();
  replies.push(() => Promise.resolve("data:image/png;base64,AA=="));
  expect(await loadPhoto(avatar)).toBe("data:image/png;base64,AA==");
  expect(calls).toBe(2);
  expect(knownPhoto(avatar)).toBe("data:image/png;base64,AA==");
});

// #335: a socket the relay closed under the ask says nothing of the photo: the
// next render asks again, with no change of connection between.
test("an ask that failed on the way to herdr is asked again on the next render", async () => {
  const a = { ...avatar, sha256: "d".repeat(64) };
  replies.push(() => Promise.reject(hostOffline()));
  expect(await loadPhoto(a)).toBeNull();
  expect(knownPhoto(a)).toBeUndefined();
  const before = calls;
  replies.push(() => Promise.resolve("data:image/png;base64,DD=="));
  expect(await loadPhoto(a)).toBe("data:image/png;base64,DD==");
  expect(calls).toBe(before + 1);
});

test("a settled ask is no longer out: its outcome is kept as a photo or a refusal", async () => {
  const loads = { ...avatar, sha256: "e".repeat(64) }, refused = { ...avatar, sha256: "f".repeat(64) };
  const answer = Promise.withResolvers<string>(), refuse = Promise.withResolvers<string>();
  replies.push(() => answer.promise, () => refuse.promise);
  const out = photoAsksOut();
  const pending = [loadPhoto(loads), loadPhoto(refused)];
  expect(photoAsksOut()).toBe(out + 2);
  answer.resolve("data:image/png;base64,EE==");
  refuse.reject(new HerdrAPIError("not_found", "no avatar", {}));
  expect(await Promise.all(pending)).toEqual(["data:image/png;base64,EE==", null]);
  expect(photoAsksOut()).toBe(out);
  expect([knownPhoto(loads), knownPhoto(refused)]).toEqual(["data:image/png;base64,EE==", null]);
});

test("a refusal from the connection before is not remembered", async () => {
  const a = { ...avatar, sha256: "b".repeat(64) };
  let fail!: (e: Error) => void;
  replies.push(() => new Promise<string>((_, reject) => (fail = reject)));
  const stale = loadPhoto(a);
  forgetFailedPhotos();
  fail(new HerdrAPIError("not_found", "no avatar", {}));
  expect(await stale).toBeNull();
  expect(knownPhoto(a)).toBeUndefined();
});

// #42: switching session keeps the SSH connection, so no "connecting" state
// arrives; the board's session changing must forget the refusal all the same.
test("a photo herdr refused is asked for again in another session", async () => {
  const a = { ...avatar, sha256: "c".repeat(64) };
  boardShown("");
  replies.push(() => Promise.reject(goError("herdr: not_found: no avatar")));
  expect(await loadPhoto(a)).toBeNull();
  const before = calls;

  // Another board of the same session keeps the refusal.
  boardShown("");
  expect(knownPhoto(a)).toBeNull();
  expect(await loadPhoto(a)).toBeNull();
  expect(calls).toBe(before);

  // The board now shows session work: the photo is fetched again.
  boardShown("work");
  expect(knownPhoto(a)).toBeUndefined();
  replies.push(() => Promise.resolve("data:image/png;base64,BB=="));
  expect(await loadPhoto(a)).toBe("data:image/png;base64,BB==");
  expect(calls).toBe(before + 1);
});
