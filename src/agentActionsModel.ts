// The pure rules behind the agent menus' sheets (agentActions.ts): the rename
// field, the avatar photo's crop and encoding, and the harness transfer's
// states, each ported from herdrup so bun can test them.

/** herdr's agent-name grammar `^[a-z][a-z0-9_-]{0,31}$` (herdrup
 * Sources/HerdrKit/AgentName.swift 11-29; Go normalizeAgentName in
 * desk_create.go): lowercased, anything before the first letter dropped, any
 * other character a "-", 32 at most, "agent" when nothing is left. */
export function normalizeAgentName(raw: string): string {
  let out = "";
  for (const c of raw.toLowerCase()) {
    if (out === "") {
      if (c >= "a" && c <= "z") out += c;
    } else if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_") {
      out += c;
    } else {
      out += "-";
    }
    if (out.length >= 32) break;
  }
  return out === "" ? "agent" : out;
}

/** RenameSheet's field state (HerdrApp.swift 9585-9655): the name is the
 * trimmed input normalised; Save needs a non-empty input, and "Will be saved
 * as <effective>" shows only when normalising changed it. */
export function renameField(value: string): { effective: string; canSave: boolean; showPreview: boolean } {
  // Swift trims .whitespacesAndNewlines; String.prototype.trim covers them.
  const trimmed = value.trim();
  const effective = normalizeAgentName(trimmed);
  const canSave = trimmed !== "" && effective !== "";
  return { effective, canSave, showPreview: canSave && effective !== trimmed };
}

/** AgentAvatarImage (Sources/HerdrKit/AgentAvatarDescriptor.swift 188-194):
 * the server's byte cap, the uploaded edge and the JPEG quality ladder. */
export const AVATAR_MAX_BYTES = 64 * 1024;
export const AVATAR_PIXEL_SIZE = 256;
export const AVATAR_QUALITY_LADDER = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.15] as const;
/** AgentAvatarPhoto.workingEdge (App/AgentAvatarViews.swift 566): the
 * longest edge a picked photo is decoded at. */
export const AVATAR_WORKING_EDGE = 1600;
/** AgentAvatarCropView's viewport and zoom range (AgentAvatarViews.swift
 * 485, 556). */
export const CROP_VIEWPORT = 280;
export const CROP_MAX_ZOOM = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The square of the source image, in source pixels, that the crop shows
 * (AgentAvatarImage.cropRect, AgentAvatarDescriptor.swift 214-225): zoom >= 1
 * shrinks the largest centred square, the offset moves its centre in units of
 * the free travel on each axis (-1 ... 1, clamped). */
export function cropRect(imageWidth: number, imageHeight: number, zoom: number, offsetX: number, offsetY: number) {
  const side = Math.min(imageWidth, imageHeight) / Math.max(zoom, 1);
  const travelX = (imageWidth - side) / 2;
  const travelY = (imageHeight - side) / 2;
  return { x: travelX + clamp(offsetX, -1, 1) * travelX, y: travelY + clamp(offsetY, -1, 1) * travelY, side };
}

/** AgentAvatarPhoto.cropRect's `.integral` (AgentAvatarViews.swift
 * 581-586): the smallest whole-pixel rectangle holding the crop. */
export function integralCropRect(imageWidth: number, imageHeight: number, zoom: number, offsetX: number, offsetY: number) {
  const r = cropRect(imageWidth, imageHeight, zoom, offsetX, offsetY);
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.side) - x, height: Math.ceil(r.y + r.side) - y };
}

/** A drag of (dx, dy) points over the viewport as a new normalised offset
 * (AgentAvatarPhoto.offset, AgentAvatarViews.swift 594-605). Dragging the
 * picture right shows more of its left: the crop moves the other way. */
export function dragOffset(start: { x: number; y: number }, dx: number, dy: number, viewport: number,
  imageWidth: number, imageHeight: number, zoom: number): { x: number; y: number } {
  const side = Math.min(imageWidth, imageHeight) / Math.max(zoom, 1);
  const pixelsPerPoint = side / viewport;
  const travelX = (imageWidth - side) / 2;
  const travelY = (imageHeight - side) / 2;
  const mx = travelX > 0 ? (-dx * pixelsPerPoint) / travelX : 0;
  const my = travelY > 0 ? (-dy * pixelsPerPoint) / travelY : 0;
  return { x: clamp(start.x + mx, -1, 1), y: clamp(start.y + my, -1, 1) };
}

/** The zoom after a pinch, held to 1 ... 6 (AgentAvatarCropView's pinch,
 * AgentAvatarViews.swift 552-558). */
export function clampZoom(zoom: number): number {
  return clamp(zoom, 1, CROP_MAX_ZOOM);
}

/** The edge a picked photo is decoded at: its own, or scaled so the longest
 * edge is AVATAR_WORKING_EDGE (AgentAvatarPhoto.downsampled's
 * kCGImageSourceThumbnailMaxPixelSize). */
export function workingSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, AVATAR_WORKING_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The first encoding along the ladder that fits maxBytes, or null when even
 * the lowest quality does not or the encoder fails every time
 * (AgentAvatarImage.encodeWithinLimit, AgentAvatarDescriptor.swift 198-210). */
export async function encodeWithinLimit(encode: (quality: number) => Promise<Uint8Array | null>,
  maxBytes = AVATAR_MAX_BYTES, qualities: readonly number[] = AVATAR_QUALITY_LADDER): Promise<Uint8Array | null> {
  for (const quality of qualities) {
    const data = await encode(quality);
    if (data && data.length > 0 && data.length <= maxBytes) return data;
  }
  return null;
}

/** AgentSessionTransferHarness.displayName (Sources/HerdrKit/Wire.swift
 * 154-161); an unknown harness shows its raw id. */
export function harnessDisplayName(harness: string): string {
  return harness === "claude" ? "Claude Code" : harness === "codex" ? "Codex" : harness === "omp" ? "Oh My Pi" : harness;
}

/** AgentSessionTransferPhase (Wire.swift 165-211): isTerminal stops polling
 * (an unknown phase too); isConclusive makes a new transfer safe to start. */
export const KNOWN_TRANSFER_PHASES = ["preparing", "ready", "verifying_cutover", "launching_target", "awaiting_target",
  "completed", "rolling_back", "rolled_back", "failed"] as const;
export function transferPhaseIsTerminal(phase: string): boolean {
  return phase === "completed" || phase === "rolled_back" || phase === "failed" || !(KNOWN_TRANSFER_PHASES as readonly string[]).includes(phase);
}
export function transferPhaseIsConclusive(phase: string): boolean {
  return phase === "completed" || phase === "rolled_back" || phase === "failed";
}

/** The durable transfer on an agent.list entry (AgentSessionTransferInfo,
 * Wire.swift 252-266), as the daemon sends it. */
export interface TransferOmissions {
  tool_records?: number; reasoning_records?: number; system_records?: number; attachment_records?: number;
  metadata_records?: number; unsupported_blocks?: number; sidechain_records?: number;
}
export interface TransferInfo {
  id: string; source: string; target: string; target_account?: string | null; phase: string;
  message_count?: number; omissions?: TransferOmissions; error?: string | null;
}
export interface TransferAgent { agent_status?: string | null; terminal_id?: string | null; session_transfer?: TransferInfo | null }

/** A daemon reply's agent, or null for "" and anything unreadable. The reply is
 * either the agent itself (agent.list's entry, whose `agent` is the harness name,
 * "claude") or a transfer reply wrapping it ({agent: {…}}): unwrap only an object
 * (issue #81). */
export function agentFrom(json: string): TransferAgent | null {
  if (!json) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const inner = (parsed as { agent?: unknown }).agent;
  return (inner && typeof inner === "object" ? inner : parsed) as TransferAgent;
}

/** The transfer the sheet opens on: the agent's own, unless it is conclusive
 * or runs another direction (AgentSessionTransferSheet.swift 38-44). */
export function existingTransfer(agent: TransferAgent | null, source: string, target: string): TransferInfo | null {
  const info = agent?.session_transfer;
  if (!info || transferPhaseIsConclusive(info.phase) || info.source !== source || info.target !== target) return null;
  return info;
}
