import { expect, test } from "bun:test";
import { migrateSavedPrompts } from "../src/composer";
import { createPromptsDesk } from "../src/web/prompts";

function memory() {
 const items = new Map<string, string>();
 return {
  items,
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => { items.set(key, value); },
  removeItem: (key: string) => { items.delete(key); },
 };
}

const legacy = "dev.herdr.savedPrompts.v1";

test("the WebView's old prompt list moves into Desk once, ids kept, and the old key is cleared", async () => {
 const storage = memory();
 const desk = createPromptsDesk(() => storage);
 storage.setItem(legacy, JSON.stringify([
  { id: "0F8FAD5B-D9CB-469F-A165-70867728950E", nickname: " standup ", text: "What did you do?" },
  { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", nickname: "", text: "run the tests" },
 ]));
 await migrateSavedPrompts(storage, desk);
 const moved = [
  { id: "0f8fad5b-d9cb-469f-a165-70867728950e", nickname: "standup", text: "What did you do?" },
  { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", nickname: "", text: "run the tests" },
 ];
 expect(await desk.savedPrompts()).toEqual(moved);
 expect(storage.getItem(legacy)).toBeNull();

 // Another window still holding the old list adds nothing.
 storage.setItem(legacy, JSON.stringify([{ id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", nickname: "", text: "late" }]));
 await migrateSavedPrompts(storage, desk);
 expect(await desk.savedPrompts()).toEqual(moved);
});

test("the browser guest's prompts save, edit in place and delete", async () => {
 const storage = memory();
 const desk = createPromptsDesk(() => storage);
 const [first] = await desk.savePrompt({ id: "", nickname: " a ", text: "one" });
 await desk.savePrompt({ id: "", nickname: "", text: "two" });
 expect(first!.nickname).toBe("a");
 const edited = await desk.savePrompt({ ...first!, text: "one, edited" });
 expect(edited.map(p => p.text)).toEqual(["one, edited", "two"]);
 expect((await desk.deletePrompt(first!.id)).map(p => p.text)).toEqual(["two"]);
 await expect(desk.savePrompt({ id: "", nickname: "", text: "  " })).rejects.toThrow();
});

test("a browser that refuses storage still makes the guest Desk; the prompt calls fail instead", async () => {
 const refused = new Error("SecurityError: The operation is insecure.");
 const desk = createPromptsDesk(() => { throw refused; });
 await expect(desk.savedPrompts()).rejects.toBe(refused);
 await expect(desk.savePrompt({ id: "", nickname: "", text: "one" })).rejects.toBe(refused);
});
