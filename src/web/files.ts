// A browser has no file paths: the screens pass paths (MyGo's onFileDrop, Desk.gramAttachFiles,
// Desk.paneAttachFiles), so each File the page is given gets a path of its own here,
// "browser-file:<n>/<name>", which the Desk methods turn back into the File.

const files = new Map<string, File>();
let next = 0;

/** Paths for files, in order; each names its File until forgetFile. */
export function registerFiles(list: Iterable<File>): string[] {
 return [...list].map((file) => {
  const path = `browser-file:${++next}/${file.name}`;
  files.set(path, file);
  return path;
 });
}

export function fileForPath(path: string): File | undefined { return files.get(path); }

export function forgetFile(path: string): void { files.delete(path); }

/** Lets the person choose files, as the open dialog does; [] when they cancel. */
export function pickFiles(multiple = true): Promise<File[]> {
 const { promise, resolve } = Promise.withResolvers<File[]>();
 const input = document.createElement("input");
 input.type = "file";
 input.multiple = multiple;
 input.addEventListener("change", () => resolve([...(input.files ?? [])]), { once: true });
 input.addEventListener("cancel", () => resolve([]), { once: true });
 input.click();
 return promise;
}
