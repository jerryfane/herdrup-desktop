// Agent avatars as herdrup draws them (App/AgentAvatarViews.swift
// AgentAvatarView): a bundled mascot, a photo fetched by sha256, or the
// initial tile. The status badge goes on top of any of them (main.ts).
import { Desk, type Avatar } from "./mygo";

/** Photos by sha256: the data: URL once fetched, null after a failure, which
 * herdrup draws as the initial tile. Desk caches the bytes on disk. A failure
 * is remembered for the connection only, as Desk's own store does: a new
 * connection forgets it (forgetFailedPhotos) and the photo is asked for
 * again (#36). */
const photos = new Map<string, string | null>();
const loading = new Map<string, Promise<string | null>>();
/** Counts connections, so a fetch begun on an older one records no failure. */
let connection = 0;

/** What is known of sha's photo: its URL, null after a failure on this
 * connection, undefined before it is fetched. */
export function knownPhoto(sha: string): string | null | undefined {
  return photos.get(sha);
}

/** Forgets the photos that failed, for a new connection. */
export function forgetFailedPhotos() {
  connection++;
  for (const [sha, url] of photos) if (url === null) photos.delete(sha);
  loading.clear();
}

export function loadPhoto(a: Avatar): Promise<string | null> {
  const sha = a.sha256 ?? "";
  let p = loading.get(sha);
  if (!p) {
    const on = connection;
    p = Desk.avatarImage(a.target ?? "", sha).then(
      (url) => {
        photos.set(sha, url);
        return url;
      },
      (err) => {
        console.error(`avatar ${sha}:`, err);
        // A lost connection is not a broken photo: try again later.
        if (String(err).includes("not connected") || on !== connection) {
          if (loading.get(sha) === p) loading.delete(sha);
          return null;
        }
        photos.set(sha, null);
        return null;
      },
    );
    loading.set(sha, p);
  }
  return p;
}

/** The mascot's art, synced from herdrup (public/herdrup/mascots). */
export const mascotURL = (id: string) => `/herdrup/mascots/${id}.svg`;

/** The avatar's face at the avatar's size: `initial` builds the initial
 * tile, which is also what a failed photo shows. A photo still loading is a
 * plain surfaceRaised circle and is swapped in when it arrives. */
export function avatarFace(a: Avatar | undefined, initial: () => HTMLElement): HTMLElement {
  if (a?.kind === "mascot" && a.mascot) {
    const img = document.createElement("img");
    img.className = "face mascot";
    img.alt = "";
    img.src = mascotURL(a.mascot);
    // A mascot this build has no art for falls back to the tile.
    img.addEventListener("error", () => img.replaceWith(initial()), { once: true });
    return img;
  }
  if (a?.kind === "image" && a.sha256) {
    const known = knownPhoto(a.sha256);
    if (known === null) return initial();
    if (known !== undefined) return photo(known);
    const wait = document.createElement("div");
    wait.className = "face loading";
    void loadPhoto(a).then((url) => {
      if (wait.parentNode) wait.replaceWith(url ? photo(url) : initial());
    });
    return wait;
  }
  return initial();
}

function photo(url: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "face photo";
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  box.append(img);
  return box;
}
