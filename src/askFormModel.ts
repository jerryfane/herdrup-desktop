// omp's HTML-form `ask` (omp 18.18.3), as herdr reports it (herdr ↔ herdrup ask-form contract,
// 2026-11-10): the form on the transcript entry and the pending ask, the answers once the tool
// result arrives, and agent.answer_form's values. The answer text and the checks follow omp's
// packages/tui/src/html-form/data.ts (formAnswers, choiceValue, fieldError), so the review step
// says what omp will report.

// herdr leaves out false flags and null values (omitempty), so they are optional here.
export interface AskFormOption { value: string; label: string; checked?: boolean; disabled?: boolean }
export interface AskFormField {
 name: string;
 kind: "choice" | "text";
 /** The <legend>, else the field's label, else null. */
 title?: string | null;
 /** The section's context before the field, as plain text; null if none. */
 description?: string | null;
 multi?: boolean;
 /** From a <select>: never has Other. */
 select?: boolean;
 /** omp adds a free-text "Other" answer. */
 other?: boolean;
 required?: boolean;
 /** Choice fields only. */
 options?: AskFormOption[];
 input_type?: string | null; placeholder?: string | null; value?: string | null;
 min?: number | null; max?: number | null; minlength?: number | null; maxlength?: number | null; pattern?: string | null;
}
export interface AskForm { intro?: string | null; fields: AskFormField[] }
export interface AskFormAnswer { name: string; question: string; answer: string }
export type AskFormStatus = "answered" | "timed_out" | "cancelled";

/** One field's answer while the owner steps through the form. `other` is null until Other is
 *  chosen; then it is the typed text (empty while still blank). */
export interface FieldDraft { options: string[]; other: string | null; text: string }
export type FormDraft = Record<string, FieldDraft>;
/** agent.answer_form's value for one field. */
export interface FieldValue { options?: string[]; other?: string; text?: string }

/** A choice field's options; herdr leaves the list out for text fields. */
export function optionsOf(field: AskFormField): AskFormOption[] {
 return field.options ?? [];
}
/** The agent's recommendation: every field as omp preselected it. */
export function formDraft(form: AskForm): FormDraft {
 const draft: FormDraft = {};
 for (const field of form.fields) {
  draft[field.name] = {
   options: field.kind === "choice" ? optionsOf(field).filter(option => option.checked && !option.disabled).map(option => option.value) : [],
   other: null,
   text: field.kind === "text" ? field.value ?? "" : "",
  };
 }
 return draft;
}

/** A checkbox group or multi-select of two or more options answers with a list (omp isArrayChoice). */
export function isListChoice(field: AskFormField): boolean {
 return field.kind === "choice" && !!field.multi && optionsOf(field).length > 1;
}

/** Choose `value`: a radio or single select keeps only it and drops Other; a list toggles it; a
 *  lone checkbox toggles between it and nothing. */
export function chooseOption(field: AskFormField, draft: FieldDraft, value: string): FieldDraft {
 if (!field.multi) return { ...draft, options: [value], other: null };
 const options = draft.options.includes(value) ? draft.options.filter(v => v !== value) : [...draft.options, value];
 return { ...draft, options: optionsOf(field).filter(option => options.includes(option.value)).map(option => option.value) };
}

/** Open Other: a radio's Other replaces its option, a list's joins its options. */
export function chooseOther(field: AskFormField, draft: FieldDraft): FieldDraft {
 if (!field.other) return draft;
 if (draft.other !== null && field.multi) return { ...draft, other: null };
 return { ...draft, options: field.multi ? draft.options : [], other: draft.other ?? "" };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The question a field asks: its title, else its description's first line, else a lone option's
 *  label, else its name (omp fieldQuestions: label, caption, section title, lone option, name). */
export function fieldQuestion(field: AskFormField): string {
 const description = field.description?.split("\n").find(line => line.trim() !== "") ?? "";
 const options = optionsOf(field);
 const lone = field.kind === "choice" && options.length === 1 ? options[0]!.label : "";
 return oneLine(field.title || description || lone || field.name);
}

/** What omp will report for the field (omp answerText): option labels, comma-joined, "Other: …"
 *  for typed text, the text of a text field; "" when nothing is chosen. */
export function fieldAnswer(field: AskFormField, draft: FieldDraft): string {
 if (field.kind === "text") return draft.text;
 const labels = optionsOf(field).filter(option => draft.options.includes(option.value) && !option.disabled).map(option => oneLine(option.label) || option.value);
 const typed = field.other ? draft.other?.trim() : "";
 if (typed) {
  if (!isListChoice(field)) return `Other: ${typed}`;
  labels.push(`Other: ${typed}`);
 }
 return isListChoice(field) ? labels.join(", ") : labels[0] ?? "";
}

/** The field differs from the agent's recommendation. */
export function fieldChanged(field: AskFormField, draft: FieldDraft, initial: FieldDraft): boolean {
 if (field.kind === "text") return draft.text !== initial.text;
 if ((draft.other?.trim() ?? "") !== "") return true;
 return draft.options.length !== initial.options.length || draft.options.some(value => !initial.options.includes(value));
}

/** Why the field's answer can't be sent, or null (omp fieldError). Other chosen but left blank is
 *  no answer, as omp counts it. */
export function fieldProblem(field: AskFormField, draft: FieldDraft): string | null {
 if (field.kind === "choice") {
  const typed = field.other && (draft.other?.trim() ?? "") !== "";
  if (draft.other !== null && !typed && !field.multi) return "Type your answer, or pick an option";
  if (!field.required || draft.options.length > 0 || typed) return null;
  return isListChoice(field) ? "Select at least one" : "Required";
 }
 const text = draft.text;
 if (text.trim() === "") return field.required ? "Required" : null;
 const type = field.input_type ?? "text";
 if (type === "number" || type === "range") {
  const number = Number(text);
  if (!Number.isFinite(number)) return "Enter a number";
  if (field.min != null && number < field.min) return `Must be at least ${field.min}`;
  if (field.max != null && number > field.max) return `Must be at most ${field.max}`;
 }
 if (field.minlength != null && text.length < field.minlength) return `Needs at least ${field.minlength} characters`;
 if (field.maxlength != null && text.length > field.maxlength) return `At most ${field.maxlength} characters`;
 if (type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
 if (type === "url" && !URL.canParse(text)) return "Enter a full URL";
 if (field.pattern) {
  let pattern: RegExp | null = null;
  try { pattern = new RegExp(`^(?:${field.pattern})$`, "v"); } catch { pattern = null; }
  if (pattern && !pattern.test(text)) return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
 }
 return null;
}

/** agent.answer_form's values: only the fields that differ from the recommendation, since a field
 *  left out keeps its default (`{}` accepts every recommendation). */
export function formValues(form: AskForm, draft: FormDraft): Record<string, FieldValue> {
 const initial = formDraft(form), values: Record<string, FieldValue> = {};
 for (const field of form.fields) {
  const now = draft[field.name] ?? initial[field.name]!;
  if (!fieldChanged(field, now, initial[field.name]!)) continue;
  if (field.kind === "text") { values[field.name] = { text: now.text }; continue; }
  const typed = field.other ? now.other?.trim() ?? "" : "";
  values[field.name] = typed ? { options: field.multi ? now.options : [], other: typed } : { options: now.options };
 }
 return values;
}

/** The first field whose answer can't be sent, as its index, or -1. */
export function firstProblem(form: AskForm, draft: FormDraft): number {
 const initial = formDraft(form);
 return form.fields.findIndex(field => fieldProblem(field, draft[field.name] ?? initial[field.name]!) !== null);
}
