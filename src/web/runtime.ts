// The part of mygo-runtime the screens use outside src/mygo.ts, for the browser build (aliased in
// vite.web.config.ts). onFileDrop's paths are browser-file paths (files.ts) for the dropped Files.

import type { FileDrop } from "mygo-runtime";
import { registerFiles } from "./files";

export type { FileDrop };

const drops = new Set<(drop: FileDrop) => void>();

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
// A file dropped where nothing takes it would replace the page with the file.
addEventListener("dragover", (event) => { if (carriesFiles(event)) event.preventDefault(); });
addEventListener("drop", (event) => {
 if (!carriesFiles(event)) return;
 event.preventDefault();
 const files = [...(event.dataTransfer?.files ?? [])];
 if (files.length === 0 || drops.size === 0) return;
 const drop = { paths: registerFiles(files), x: event.clientX, y: event.clientY };
 for (const listener of [...drops]) listener(drop);
});

export function onFileDrop(listener: (drop: FileDrop) => void): () => void {
 drops.add(listener);
 return () => { drops.delete(listener); };
}
