import { expect, test } from "bun:test";
import { chooseOption, chooseOther, dropEmptyOther, fieldAnswer, fieldProblem, fieldQuestion, firstProblem, formDraft, formValues, type AskForm, type AskFormField, type FieldDraft } from "../src/askFormModel";

const choice = (name: string, fields: Partial<AskFormField> = {}): AskFormField => ({
 name, kind: "choice", title: name, description: null, multi: false, select: false, other: true, required: false,
 options: [{ value: "a", label: "Apex", checked: true }, { value: "b", label: "Beta", checked: false }, { value: "c", label: "Gamma", checked: false }],
 ...fields,
});
const text = (name: string, fields: Partial<AskFormField> = {}): AskFormField => ({
 name, kind: "text", title: name, description: null, multi: false, select: false, other: false, required: false, options: [], input_type: "text", value: "", ...fields,
});
const form = (...fields: AskFormField[]): AskForm => ({ intro: null, fields });
/** fieldProblem against the field's own recommendation. */
const problem = (field: AskFormField, draft: FieldDraft) => fieldProblem(field, draft, formDraft(form(field))[field.name]!);

test("accepting every recommendation sends no values", () => {
 const f = form(choice("where"), choice("who", { multi: true }), text("notes", { value: "ok" }));
 expect(formValues(f, formDraft(f))).toEqual({});
 expect(firstProblem(f, formDraft(f))).toBe(-1);
});

// herdr leaves out false flags, null values and a text field's options (omitempty).
test("a form with herdr's omitted fields reads as their defaults", () => {
 const f: AskForm = { fields: [
  { name: "where", kind: "choice", options: [{ value: "a", label: "Apex" }, { value: "b", label: "Beta", checked: true }] },
  { name: "notes", kind: "text" },
 ] };
 const draft = formDraft(f);
 expect(draft).toEqual({ where: { options: ["b"], other: null, text: "" }, notes: { options: [], other: null, text: "" } });
 expect(fieldAnswer(f.fields[0]!, draft.where!)).toBe("Beta");
 expect(fieldQuestion(f.fields[1]!)).toBe("notes");
 expect(firstProblem(f, draft)).toBe(-1);
 expect(formValues(f, { ...draft, where: chooseOption(f.fields[0]!, draft.where!, "a") })).toEqual({ where: { options: ["a"] } });
});

// A field left out keeps its default, so emptying a prefilled text field must be sent.
test("clearing a prefilled text field sends empty text", () => {
 const f = form(text("notes", { value: "ship it" }));
 expect(formValues(f, { notes: { options: [], other: null, text: "" } })).toEqual({ notes: { text: "" } });
});

// omp checks lengths and the pattern on the number a number field submits (omp textValue).
test("a number field is checked and reported as the number it reads as", () => {
 const n = text("n", { input_type: "number", value: "1.0", maxlength: 1, pattern: "[0-9]" });
 const draft = formDraft(form(n)).n!;
 expect(problem(n, draft)).toBeNull();
 expect(fieldAnswer(n, draft)).toBe("1");
});

// herdr refuses control characters in what it types, except a textarea's new lines and tabs.
test("an answer herdr can't type is caught before Submit", () => {
 const where = choice("where");
 expect(problem(where, { options: [], other: "two\nlines", text: "" })).toBe("Keep your answer on one line");
 const draft = (value: string) => ({ options: [], other: null, text: value });
 expect(problem(text("n"), draft("a\tb"))).toBe("Keep your answer on one line");
 expect(problem(text("n", { input_type: "textarea" }), draft("line one\nline two\tok"))).toBeNull();
 // herdr types only what differs, trimmed: an untouched default and Other's outer blanks pass.
 expect(problem(text("n", { value: "a\tb" }), draft("a\tb"))).toBeNull();
 expect(problem(where, { options: [], other: "\tanswer\t", text: "" })).toBeNull();
});

test("a radio answers with exactly one option or Other", () => {
 const f = form(choice("where"));
 const where = f.fields[0]!;
 let draft = formDraft(f);
 draft = { where: chooseOption(where, draft.where!, "b") };
 expect(formValues(f, draft)).toEqual({ where: { options: ["b"] } });
 expect(fieldAnswer(where, draft.where!)).toBe("Beta");

 draft = { where: chooseOther(where, draft.where!) };
 expect(draft.where!.options).toEqual([]);
 // Other chosen but blank is no answer, as omp counts it.
 expect(problem(where, draft.where!)).toBe("Type your answer, or pick an option");
 expect(firstProblem(f, draft)).toBe(0);

 draft = { where: { ...draft.where!, other: "  ops@lenscale.ai " } };
 expect(problem(where, draft.where!)).toBeNull();
 expect(formValues(f, draft)).toEqual({ where: { options: [], other: "ops@lenscale.ai" } });
 expect(fieldAnswer(where, draft.where!)).toBe("Other: ops@lenscale.ai");

 // Picking an option again drops the typed answer.
 draft = { where: chooseOption(where, draft.where!, "a") };
 expect(draft.where!.other).toBeNull();
 expect(formValues(f, draft)).toEqual({});
});

test("a checkbox group keeps form order and adds Other to its options", () => {
 const f = form(choice("who", { multi: true }));
 const who = f.fields[0]!;
 let draft = formDraft(f).who!;
 draft = chooseOption(who, draft, "c");
 draft = chooseOption(who, draft, "b");
 expect(draft.options).toEqual(["a", "b", "c"]);
 draft = chooseOption(who, draft, "a");
 draft = { ...chooseOther(who, draft), other: "Dana" };
 expect(fieldAnswer(who, draft)).toBe("Beta, Gamma, Other: Dana");
 expect(formValues(f, { who: draft })).toEqual({ who: { options: ["b", "c"], other: "Dana" } });
 // Choosing Other again closes it.
 expect(chooseOther(who, draft).other).toBeNull();
});

test("required fields and text constraints block the answer", () => {
 const none = choice("pick", { required: true, options: [{ value: "a", label: "A", checked: false }, { value: "b", label: "B", checked: false }] });
 expect(problem(none, formDraft(form(none)).pick!)).toBe("Required");
 expect(problem({ ...none, multi: true }, { options: [], other: null, text: "" })).toBe("Select at least one");

 const draft = (value: string) => ({ options: [], other: null, text: value });
 expect(problem(text("n", { required: true }), draft(" "))).toBe("Required");
 expect(problem(text("n", { input_type: "number", min: 1, max: 5 }), draft("9"))).toBe("Must be at most 5");
 expect(problem(text("n", { input_type: "number" }), draft("two"))).toBe("Enter a number");
 expect(problem(text("n", { input_type: "email" }), draft("ops"))).toBe("Enter an email address");
 expect(problem(text("n", { input_type: "url" }), draft("lenscale.ai"))).toBe("Enter a full URL");
 expect(problem(text("n", { pattern: "[a-z]+" }), draft("abc1"))).toBe("Must match [a-z]+");
 expect(problem(text("n", { maxlength: 3 }), draft("abcd"))).toBe("At most 3 characters");
 expect(problem(text("n", { pattern: "(" }), draft("x"))).toBeNull();
});

test("a field's question falls back from title to description to a lone option to its name", () => {
 expect(fieldQuestion(choice("x", { title: "Where to build" }))).toBe("Where to build");
 expect(fieldQuestion(choice("x", { title: null, description: "\nWhich database?\n\nMore" }))).toBe("Which database?");
 expect(fieldQuestion(choice("x", { title: null, options: [{ value: "y", label: "Send me a Gram", checked: false }] }))).toBe("Send me a Gram");
 expect(fieldQuestion(text("notes", { title: null }))).toBe("notes");
});

// herdrup#688 (AskFormTests testDisabledOptionsAreNotSent): a checked, disabled option stays
// ticked and counts toward a required field, and is never sent.
test("a checked disabled option is part of the answer but never sent", () => {
 const deps = choice("deps", { multi: true, required: true, other: false, options: [
  { value: "fixed", label: "Fixed", checked: true, disabled: true }, { value: "new", label: "New", checked: false }] });
 const f = form(deps);
 const initial = formDraft(f).deps!;
 expect(initial.options).toEqual(["fixed"]);
 expect(firstProblem(f, formDraft(f))).toBe(-1);
 expect(formValues(f, formDraft(f))).toEqual({});
 const draft = chooseOption(deps, initial, "new");
 expect(draft.options).toEqual(["fixed", "new"]);
 expect(fieldAnswer(deps, draft)).toBe("Fixed, New");
 expect(formValues(f, { deps: draft })).toEqual({ deps: { options: ["new"] } });
});

// herdrup#689 (AskFormTests 342-369): an optional radio without a default may go back to
// unanswered after an empty Other; a required radio or one with a default may not.
test("an optional radio without a default can leave an empty Other unanswered", () => {
 const where = choice("where", { options: [{ value: "a", label: "A", checked: false }] });
 const f = form(where);
 let draft = chooseOther(where, formDraft(f).where!);
 draft = { ...draft, other: "x" };
 draft = { ...draft, other: "" };
 expect(problem(where, draft)).toBeNull();
 expect(formValues(f, { where: draft })).toEqual({});
 draft = dropEmptyOther(where, draft);
 expect(draft.other).toBeNull();
 expect(fieldAnswer(where, draft)).toBe("");

 const required = choice("env", { required: true, options: [{ value: "a", label: "A", checked: false }] });
 const recommended = choice("via", { options: [{ value: "a", label: "A", checked: true }] });
 for (const field of [required, recommended]) {
  const open = chooseOther(field, formDraft(form(field))[field.name]!);
  expect(problem(field, open)).toBe("Type your answer, or pick an option");
  expect(dropEmptyOther(field, open).other).toBe("");
 }
});

// herdrup#690: a multi-choice field lists everything chosen whatever its option count, so the
// review shows what is sent.
test("a lone checkbox with Other summarises both", () => {
 const consent = choice("consent", { multi: true, options: [{ value: "yes", label: "Send me a Gram", checked: false }] });
 const draft = { ...chooseOther(consent, chooseOption(consent, formDraft(form(consent)).consent!, "yes")), other: "and email" };
 expect(formValues(form(consent), { consent: draft })).toEqual({ consent: { options: ["yes"], other: "and email" } });
 expect(fieldAnswer(consent, draft)).toBe("Send me a Gram, Other: and email");
});

// herdrup #674 review: field names are omp's, any string. Keyed by name in plain objects, a field
// named "__proto__" set the prototype and its answer was dropped, and "toString" read
// Object.prototype's. Every name is an ordinary key, in the draft and in the values sent.
test("fields named __proto__, constructor and toString keep their answers", () => {
 const f = form(text("__proto__", { value: "a" }), choice("constructor"), text("toString"));
 const draft = formDraft(f);
 expect(Object.keys(draft)).toEqual(["__proto__", "constructor", "toString"]);
 draft["__proto__"] = { ...draft["__proto__"]!, text: "changed" };
 draft["constructor"] = chooseOption(f.fields[1]!, draft["constructor"]!, "b");
 draft["toString"] = { ...draft["toString"]!, text: "typed" };
 expect(JSON.parse(JSON.stringify(formValues(f, draft)))).toEqual(JSON.parse('{"__proto__":{"text":"changed"},"constructor":{"options":["b"]},"toString":{"text":"typed"}}'));
 expect(firstProblem(f, draft)).toBe(-1);
});
