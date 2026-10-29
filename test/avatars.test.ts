import { afterAll, expect, test } from "bun:test";
import { forgetFailedPhotos, knownPhoto, loadPhoto } from "../src/avatars";
import { Desk, type Avatar } from "../src/mygo";

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

// #36: a fetch rejected while the SSH connection is going down is drawn as
// the initial tile for that connection only; once reconnected the photo is
// asked for again.
test("a failed photo is asked for again on a new connection", async () => {
  replies.push(() => Promise.reject(new Error("ssh: connection lost")));
  expect(await loadPhoto(avatar)).toBeNull();
  expect(knownPhoto(sha)).toBeNull();
  // Same connection: remembered, not fetched again.
  expect(await loadPhoto(avatar)).toBeNull();
  expect(calls).toBe(1);

  forgetFailedPhotos();
  expect(knownPhoto(sha)).toBeUndefined();
  replies.push(() => Promise.resolve("data:image/png;base64,AA=="));
  expect(await loadPhoto(avatar)).toBe("data:image/png;base64,AA==");
  expect(calls).toBe(2);
  expect(knownPhoto(sha)).toBe("data:image/png;base64,AA==");
});

test("a failure from the connection before is not remembered", async () => {
  const other = "b".repeat(64);
  const a = { ...avatar, sha256: other };
  let fail!: (e: Error) => void;
  replies.push(() => new Promise<string>((_, reject) => (fail = reject)));
  const stale = loadPhoto(a);
  forgetFailedPhotos();
  fail(new Error("ssh: connection lost"));
  expect(await stale).toBeNull();
  expect(knownPhoto(other)).toBeUndefined();
});
