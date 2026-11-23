import { afterAll, expect, test } from "bun:test";
import { boardShown, forgetFailedPhotos, knownPhoto, loadPhoto, photoAsksOut } from "../src/avatars";
import { Desk, type Avatar, type AvatarPhoto } from "../src/mygo";
import { closed, HerdrAPIError, hostOffline, other, ownerRefusal, rateLimited, relayRefused, revoked, timedOut } from "../src/webguest/errors";
import { checkTag, ErrUnsupported } from "../src/web/engine";
import { avatarAnswered } from "../src/web/desk";
import { closeError } from "../src/webguest/transport";

// Desk.avatarImage answers from this queue, one reply per call.
const replies: Array<() => Promise<AvatarPhoto>> = [];
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
/** herdr's answer that there is no photo, as either Desk says it. */
const unavailable = () => Promise.resolve<AvatarPhoto>({ unavailable: true });
const photo = (url: string) => () => Promise.resolve<AvatarPhoto>({ url });
/** A desktop error as the page gets it: the Go error's text. */
const goError = (message: string) => Object.assign(new Error(message), { name: "CallError" });

/** What a failed call threw. */
const thrown = (f: () => unknown) => {
  try { f(); } catch (error) { return error; }
  throw new Error("did not throw");
};

// The web desk decides at agent.avatar.get, by the error's type, as desk_avatars.go does.
test("the web desk takes herdr's error reply, a herdr without agent_avatar and a result of another type as its answer, and nothing else", () => {
  const answered = [
    new HerdrAPIError("not_found", "no avatar", {}),
    new ErrUnsupported("agent.avatar.get", "agent_avatar", "0.9.0"),
    new ErrUnsupported("agent.avatar.get", "", ""),
    thrown(() => checkTag("agent.avatar.get", { type: "pong" }, "agent_avatar_image")),
  ];
  const onTheWay = [
    hostOffline(), closed(), timedOut(), rateLimited(), relayRefused(), revoked(), ownerRefusal("owner_busy"),
    closeError(4503, "host_offline"), closeError(1006, ""), other("The shared connection closed (code 1011)."),
    new Error("not connected"), new DOMException("The operation was aborted.", "AbortError"),
    // Words are not types: an error that only reads like herdr's answer is not one.
    new Error("herdr: not_found: no avatar"),
  ];
  for (const e of answered) expect([String(e), avatarAnswered(e)]).toEqual([String(e), true]);
  for (const e of onTheWay) expect([String(e), avatarAnswered(e)]).toEqual([String(e), false]);
});

// #36: herdr's refusal is drawn as the initial tile for that connection only;
// once reconnected the photo is asked for again.
test("a photo herdr refused is asked for again on a new connection", async () => {
  replies.push(unavailable);
  expect(await loadPhoto(avatar)).toBeNull();
  expect(knownPhoto(avatar)).toBeNull();
  // Same connection: remembered, not fetched again.
  expect(await loadPhoto(avatar)).toBeNull();
  expect(calls).toBe(1);

  forgetFailedPhotos();
  expect(knownPhoto(avatar)).toBeUndefined();
  replies.push(photo("data:image/png;base64,AA=="));
  expect(await loadPhoto(avatar)).toBe("data:image/png;base64,AA==");
  expect(calls).toBe(2);
  expect(knownPhoto(avatar)).toBe("data:image/png;base64,AA==");
});

// #369 review: Go leaves a deadline retryable; the page must not remember it. Any
// error is on the way to herdr, whatever its words, a herdr error's included.
test("Desk.avatarImage's error is asked again on the next render, whatever it says", async () => {
  for (const [n, error] of [goError("context deadline exceeded"), hostOffline(), goError("herdr: not_found: no avatar")].entries()) {
    const a = { ...avatar, sha256: String(n).repeat(64) };
    replies.push(() => Promise.reject(error));
    expect(await loadPhoto(a)).toBeNull();
    expect(knownPhoto(a)).toBeUndefined();
    const before = calls;
    replies.push(photo(`data:image/png;base64,${n}=`));
    expect(await loadPhoto(a)).toBe(`data:image/png;base64,${n}=`);
    expect(calls).toBe(before + 1);
  }
});

test("a settled ask is no longer out: its outcome is kept as a photo or a refusal", async () => {
  const loads = { ...avatar, sha256: "e".repeat(64) }, refused = { ...avatar, sha256: "f".repeat(64) };
  const answer = Promise.withResolvers<AvatarPhoto>(), refuse = Promise.withResolvers<AvatarPhoto>();
  replies.push(() => answer.promise, () => refuse.promise);
  const out = photoAsksOut();
  const pending = [loadPhoto(loads), loadPhoto(refused)];
  expect(photoAsksOut()).toBe(out + 2);
  answer.resolve({ url: "data:image/png;base64,EE==" });
  refuse.resolve({ unavailable: true });
  expect(await Promise.all(pending)).toEqual(["data:image/png;base64,EE==", null]);
  expect(photoAsksOut()).toBe(out);
  expect([knownPhoto(loads), knownPhoto(refused)]).toEqual(["data:image/png;base64,EE==", null]);
});

test("a refusal from the connection before is not remembered", async () => {
  const a = { ...avatar, sha256: "b".repeat(64) };
  const answer = Promise.withResolvers<AvatarPhoto>();
  replies.push(() => answer.promise);
  const stale = loadPhoto(a);
  forgetFailedPhotos();
  answer.resolve({ unavailable: true });
  expect(await stale).toBeNull();
  expect(knownPhoto(a)).toBeUndefined();
});

// #42: switching session keeps the SSH connection, so no "connecting" state
// arrives; the board's session changing must forget the refusal all the same.
test("a photo herdr refused is asked for again in another session", async () => {
  const a = { ...avatar, sha256: "c".repeat(64) };
  boardShown("");
  replies.push(unavailable);
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
  replies.push(photo("data:image/png;base64,BB=="));
  expect(await loadPhoto(a)).toBe("data:image/png;base64,BB==");
  expect(calls).toBe(before + 1);
});
