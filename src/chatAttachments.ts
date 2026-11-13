/** The prompt that hands an agent files posted to it through Gram, and reading it back in the
 *  chat (herdrup GramAttachmentPrompt.swift, TranscriptAttachment.swift). */

/** A file named in a prompt: its name, whether it was sent as a photo, its Gram message id. */
export interface PromptFile { name: string; isImage: boolean; messageID: string }

/** paneAttachmentPrompt (desk_interaction_compose.go:168-205, GramAttachmentPrompt.text): the
 *  typed text, then how to download each attachment. One file keeps its own wording; several
 *  are listed with one download command each. */
export function paneAttachmentPrompt(text: string, files: readonly { name: string; isImage: boolean; messageID?: string }[]): string {
 const paths = files.map(file => {
  const dot = file.name.lastIndexOf(".");
  const ext = (dot >= 0 ? file.name.slice(dot + 1) : "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const path = "/tmp/herdr-" + (file.isImage ? "photo" : "file") + "-" + file.messageID;
  return ext ? path + "." + ext : path;
 });
 let reference: string;
 const file = files[0];
 if (files.length === 1 && file) {
  const noun = file.isImage ? "Photo" : "File " + file.name;
  reference = `[${noun} attached via Herdr Gram message ${file.messageID}. Download it with \`herdr gram get-file ${file.messageID} -o ${paths[0]}\`, then inspect ${paths[0]}.]`;
 } else {
  const lines = files.map((file, i) => `\`herdr gram get-file ${file.messageID} -o ${paths[i]}\`  (${file.name})`);
  reference = `[${files.length} files attached via Herdr Gram. Download them with:\n${lines.join("\n")}\nthen inspect ${paths.join(", ")}.]`;
 }
 return text.trim() === "" ? reference : text + "\n\n" + reference;
}

/** A prompt read back: what was typed, and the files. */
export interface ParsedPrompt { caption: string; files: PromptFile[] }

/** GramAttachmentPrompt.parse: only a complete envelope paneAttachmentPrompt writes, so a
 *  prompt that merely looks like one, or one edited, stays ordinary text. Nothing in it is run:
 *  only the message ids are used, and herdr still decides who may fetch each file. */
export function parseAttachmentPrompt(prompt: string): ParsedPrompt | null {
 if (!prompt.endsWith(".]")) return null;
 let caption: string, reference: string;
 const boundary = prompt.lastIndexOf("\n\n[");
 if (boundary >= 0) { caption = prompt.slice(0, boundary); reference = prompt.slice(boundary + 2); }
 else if (prompt.startsWith("[")) { caption = ""; reference = prompt; }
 else return null;
 const files: PromptFile[] = [];
 if (reference.startsWith("[Photo attached via Herdr Gram message ") || reference.startsWith("[File ")) {
  const marker = reference.indexOf(" attached via Herdr Gram message "), commandStart = reference.indexOf(". Download it with `");
  if (marker < 0 || commandStart < 0) return null;
  const commandEnd = reference.indexOf("`", commandStart + ". Download it with `".length);
  if (commandEnd < 0) return null;
  const command = parseCommand(reference.slice(commandStart + ". Download it with `".length, commandEnd));
  if (!command || reference.slice(marker + " attached via Herdr Gram message ".length, commandStart) !== command.id) return null;
  const noun = reference.slice(1, marker);
  let name: string;
  if (noun === "Photo" && command.isImage) {
   const base = command.path.slice(command.path.lastIndexOf("/") + 1), dot = base.lastIndexOf(".");
   name = dot > 0 ? "Photo" + base.slice(dot) : "Photo";
  } else if (noun.startsWith("File ") && !command.isImage) name = noun.slice(5);
  else return null;
  if (!validName(name)) return null;
  files.push({ name, isImage: command.isImage, messageID: command.id });
 } else {
  const lines = reference.split("\n");
  const header = lines[0] ?? "", count = Number.parseInt(header.slice(1, header.indexOf(" ")), 10);
  if (lines.length < 4 || !(count > 1) || count !== lines.length - 2 || header !== `[${count} files attached via Herdr Gram. Download them with:`) return null;
  for (const line of lines.slice(1, -1)) {
   const separator = line.indexOf("`  (");
   if (!line.startsWith("`") || !line.endsWith(")") || separator < 0) return null;
   const command = parseCommand(line.slice(1, separator));
   const name = line.slice(separator + "`  (".length, -1);
   if (!command || !validName(name)) return null;
   files.push({ name, isImage: command.isImage, messageID: command.id });
  }
 }
 // Writing it again verifies every path, the closing instruction, the count and separators:
 // text that only resembles a download command is never hidden.
 if (new Set(files.map(file => file.messageID)).size !== files.length || paneAttachmentPrompt(caption, files) !== prompt) return null;
 return { caption, files };
}

function validName(name: string): boolean {
 // CharacterSet.controlCharacters: Unicode Cc and Cf.
 return name !== "" && !/[\p{Cc}\p{Cf}]/u.test(name);
}

function parseCommand(command: string): { id: string; path: string; isImage: boolean } | null {
 const prefix = "herdr gram get-file ", separator = command.indexOf(" -o ");
 if (!command.startsWith(prefix) || separator < 0) return null;
 const id = command.slice(prefix.length, separator);
 if (!id.startsWith("gram-") || id.length <= 5 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
 const path = command.slice(separator + " -o ".length);
 if (path.startsWith(`/tmp/herdr-photo-${id}`)) return { id, path, isImage: true };
 if (path.startsWith(`/tmp/herdr-file-${id}`)) return { id, path, isImage: false };
 return null;
}
