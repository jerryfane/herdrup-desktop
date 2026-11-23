// Agent avatars as herdrup draws them (App/AgentAvatarViews.swift
// AgentAvatarView): a bundled mascot, a photo fetched by sha256, or the
// initial tile. The status badge goes on top of any of them (main.ts).
import { Desk, type Avatar, type ConnState, type events } from "./mygo";

/** Photos that loaded, by sha256: a content address, so any agent with that
 * sha shows the bytes whichever agent they came from. Desk caches them on disk. */
const photos = new Map<string, string>();
/** Asks herdr refused, by target and sha256 (photoKey), which herdrup draws as
 * the initial tile: the same photo asked of another agent is asked anew, since
 * a list can move a photo to another pane and herdr answers not_found for the
 * old one. Only herdr's answer is remembered (definitiveAvatarFailure); an ask
 * the way to herdr failed is asked again on the next render. A refusal is
 * remembered for the connection and session only, as Desk's own store does:
 * the connection coming back up, or another session, forgets it
 * (trackPhotoConnections, boardShown) and it is asked again (#36, #42). */
const failed = new Set<string>();
/** Asks still out, keyed the same way, so an ask of one agent never waits on
 * another's. A settled ask leaves: its outcome is in photos or failed. */
const loading = new Map<string, Promise<string | null>>();
/** Counts connections and sessions, so a fetch begun on an older one
 * records no failure. */
let connection = 0;
/** The session of the last board shown, undefined before the first. */
let shownSession: string | undefined;

const photoKey = (a: Avatar) => `${a.target ?? ""} ${a.sha256 ?? ""}`;

/** What is known of a's photo: its URL once any agent's ask for that sha
 * loaded, null after a's own ask failed on this connection, undefined before
 * it is asked for. */
export function knownPhoto(a: Avatar): string | null | undefined {
  return photos.get(a.sha256 ?? "") ?? (failed.has(photoKey(a)) ? null : undefined);
}

/** Forgets the asks that failed, for a new connection or session. */
export function forgetFailedPhotos() {
  connection++;
  failed.clear();
  loading.clear();
}

/** Has the page's photos follow its connection: call once at startup. The
 * connection is up once a list goes through: "connected", unless it is
 * waiting out the relay's backoff ("reconnecting", which the web desk and a
 * desktop guest publish as "connected" once they have listed). When it comes
 * up after connecting, an error or that backoff, the asks that failed are
 * forgotten; a fetch the backoff refused fails before that, and one still out
 * then records nothing. The page may still draw the board from before, even
 * after this (an obsolete render): its asks are of the old agents' keys, so
 * a failure there never stands for the agent the new list has the photo on.
 * Whether this runs before or after the page's own handlers does not matter.
 * A republish while up (availability, scope) forgets nothing; photos that
 * loaded always stay. Returns the unsubscribe. */
export function trackPhotoConnections(on: Pick<typeof events, "stateChanged">): () => void {
  let up = false;
  return on.stateChanged.on((s: ConnState) => {
    const now = s.phase === "connected" && s.guest?.availability !== "reconnecting";
    if (now && !up) forgetFailedPhotos();
    up = now;
  });
}

/** Notes the session a board shows, before the page draws it. A switch keeps
 * the SSH connection, so no "connecting" state marks it: asks that failed on
 * the session before are forgotten here, whether the user switched or the
 * board fell back to the default session (#42). */
export function boardShown(session: string) {
  if (shownSession !== undefined && session !== shownSession) forgetFailedPhotos();
  shownSession = session;
}

/** herdr's answers to an ask, as either Desk words them (a desktop error
 * reaches the page as its Go text): an API error "herdr: <code>: <message>"
 * (bridge/client.go, webguest/errors.ts HerdrAPIError), such as not_found; a
 * herdr without agent_avatar (ErrUnsupported, engine.go and web/engine.ts); a
 * reply that is not the photo (checkTag, ResultTagError); and bytes that are
 * not an image or not their sha256's (desk_avatars.go, web/desk.ts
 * avatarDataURL), with the desktop's own remembered refusal ("avatar photo
 * unavailable"). */
const HERDR_ANSWER = /(^|: )herdr: [a-z0-9_.]+: | does not (support|know) |: herdr answered |(^|: )(invalid )?avatar (is|bytes|doesn't|photo|sha256) /;

/** Whether a failed ask is herdr's answer for that agent and photo, kept until
 * the connection or session changes, rather than the way to herdr failing (a
 * socket the relay closed, not connected, a timeout, an abort), which the next
 * render asks again for. */
export function definitiveAvatarFailure(err: unknown): boolean {
  return HERDR_ANSWER.test(err instanceof Error ? err.message : String(err));
}

/** a's photo, asked of a's agent unless that sha has loaded already or herdr
 * refused it this connection. */
export function loadPhoto(a: Avatar): Promise<string | null> {
  const sha = a.sha256 ?? "";
  const done = photos.get(sha);
  if (done !== undefined) return Promise.resolve(done);
  const key = photoKey(a);
  if (failed.has(key)) return Promise.resolve(null);
  let p = loading.get(key);
  if (!p) {
    const on = connection;
    const settle = () => { if (loading.get(key) === p) loading.delete(key); };
    p = Desk.avatarImage(a.target ?? "", sha).then(
      (url) => {
        settle();
        photos.set(sha, url);
        return url;
      },
      (err) => {
        console.error(`avatar ${key}:`, err);
        settle();
        // Only herdr's answer on this connection is remembered.
        if (definitiveAvatarFailure(err) && on === connection) failed.add(key);
        // The same photo may have loaded from another agent meanwhile.
        return photos.get(sha) ?? null;
      },
    );
    loading.set(key, p);
  }
  return p;
}

/** How many asks are out, for tests: a settled one is not. */
export const photoAsksOut = () => loading.size;

/** The mascot's art, synced from herdrup (public/herdrup/mascots). */
export const mascotURL = (id: string) => `${import.meta.env.BASE_URL}herdrup/mascots/${id}.svg`;

/** The bundled mascots in picker order (herdrup AgentMascot,
 * Sources/HerdrKit/AgentAvatarDescriptor.swift 11-12); the picker names
 * each by its id capitalised (displayName, 16-17). */
export const MASCOTS = ["herdy", "bot", "blip", "tri", "squib", "zag", "cub", "dome", "pip", "prism", "nib", "drop"] as const;
export const mascotName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

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
    const known = knownPhoto(a);
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
