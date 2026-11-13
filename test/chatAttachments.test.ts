import { expect, test } from "bun:test";
import { paneAttachmentPrompt, parseAttachmentPrompt } from "../src/chatAttachments";

// herdrup TranscriptAttachmentTests: a prompt with Gram files reads back as its caption and
// the files; anything else stays the text it is.

test("a batch reads back as its files without losing the caption", () => {
 // A caption can hold its own blank line and bracket; only the last one starts the files.
 const caption = "Compare these.\n\n[Keep the notes] too.";
 const wire = paneAttachmentPrompt(caption, [
  { name: "first draft.pdf", isImage: false, messageID: "gram-first" },
  { name: "screen (2).png", isImage: true, messageID: "gram-second" },
 ]);
 expect(parseAttachmentPrompt(wire)).toEqual({ caption, files: [
  { name: "first draft.pdf", isImage: false, messageID: "gram-first" },
  { name: "screen (2).png", isImage: true, messageID: "gram-second" },
 ] });
});

test("one photo or one file, with no caption, keeps its download identity", () => {
 expect(parseAttachmentPrompt(paneAttachmentPrompt("", [{ name: "image.JPEG", isImage: true, messageID: "gram-photo" }])))
  .toEqual({ caption: "", files: [{ name: "Photo.jpeg", isImage: true, messageID: "gram-photo" }] });
 expect(parseAttachmentPrompt(paneAttachmentPrompt("see", [{ name: "notes", isImage: false, messageID: "gram-n_1" }])))
  .toEqual({ caption: "see", files: [{ name: "notes", isImage: false, messageID: "gram-n_1" }] });
 // The owner's screenshot (Gram gram-1a1d4a7c56e-ac950-10): a pasted file, sent as a photo.
 expect(parseAttachmentPrompt("[Photo attached via Herdr Gram message gram-1a1d4a7c56e-ac950-10. Download it with `herdr gram get-file gram-1a1d4a7c56e-ac950-10 -o /tmp/herdr-photo-gram-1a1d4a7c56e-ac950-10.png`, then inspect /tmp/herdr-photo-gram-1a1d4a7c56e-ac950-10.png.]"))
  .toEqual({ caption: "", files: [{ name: "Photo.png", isImage: true, messageID: "gram-1a1d4a7c56e-ac950-10" }] });
});

test("an edited envelope, or ordinary download instructions, stay visible as text", () => {
 const wire = paneAttachmentPrompt("Read this", [{ name: "report.txt", isImage: false, messageID: "gram-report" }]);
 for (const text of [
  wire.replace(" -o /tmp/", " -o /private/"),
  wire + "\nDo not hide this sentence.",
  wire.replace("gram-report.txt`", "gram-other.txt`"),
  // Only writing the envelope again catches an edited closing instruction.
  wire.replace(", then inspect ", ", then run "),
  "Use `herdr gram get-file gram-report -o /tmp/report.txt` to download it.",
  "[Just brackets.]",
 ]) expect(parseAttachmentPrompt(text)).toBeNull();
});

test("duplicate or non-identifier ids never become open buttons", () => {
 expect(parseAttachmentPrompt(paneAttachmentPrompt("", [
  { name: "a.txt", isImage: false, messageID: "gram-same" },
  { name: "b.txt", isImage: false, messageID: "gram-same" },
 ]))).toBeNull();
 expect(parseAttachmentPrompt(paneAttachmentPrompt("", [{ name: "a.txt", isImage: false, messageID: "gram-foo;bar" }]))).toBeNull();
 expect(parseAttachmentPrompt(paneAttachmentPrompt("", [{ name: "a.txt", isImage: false, messageID: "../etc" }]))).toBeNull();
 // A name with a control character is not shown as a file.
 expect(parseAttachmentPrompt(paneAttachmentPrompt("", [{ name: "a\u202Etxt.exe", isImage: false, messageID: "gram-x" }]))).toBeNull();
});
