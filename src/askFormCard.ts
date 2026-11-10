// The chat's card for omp's HTML-form `ask` (owner, 2026-11-10: proposal B, the stepper, as on
// iPhone): one field per step with "1 OF N" and progress dashes, the agent's recommendation
// preselected and marked, an Other row that opens a text field, Back / Next, and a review step
// whose Submit sends agent.answer_form. Answered, the card lists the answers one per line; a
// reader who can't answer sees the first field read-only.
import { chooseOption, chooseOther, fieldAnswer, fieldChanged, fieldProblem, fieldQuestion, firstProblem, formDraft, formValues, optionsOf, type AskForm, type AskFormAnswer, type AskFormField, type AskFormStatus, type FieldValue, type FormDraft } from "./askFormModel";
import { symbolNow } from "./symbol";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag);
 if (cls) node.className = cls;
 if (text !== undefined) node.textContent = text;
 return node;
}
function button(cls: string, run: () => void, text?: string): HTMLButtonElement {
 const node = el("button", cls, text);
 node.type = "button";
 node.onclick = event => { event.stopPropagation(); run(); };
 return node;
}

/** Where the owner is in one form; kept per ask while the page lives, so a refresh keeps it. */
export interface AskFormState {
 /** 0…fields-1 a field, fields the review step. */
 step: number;
 draft: FormDraft;
 /** A field opened from the review step returns there. */
 fromReview: boolean;
 /** The field whose problem shows, after Next or Submit found one. */
 shownProblem: string | null;
 /** Bumped on every change that redraws the card; typing doesn't, so it keeps the focus. */
 version: number;
 /** Other was just opened on this card: its field takes the focus once that card is drawn. */
 focusOther: "chat" | "sheet" | null;
}

export function askFormState(form: AskForm): AskFormState {
 return { step: 0, draft: formDraft(form), fromReview: false, shownProblem: null, version: 0, focusOther: null };
}

export interface AskFormCardInput {
 form: AskForm;
 state: AskFormState;
 /** The owner (or a guest the host lets answer) may answer from the chat. */
 answerable: boolean;
 /** A guest's host keeps answers for this owner. */
 waiting: string | null;
 sending: boolean;
 problem: { message: string; offersTerminal: boolean } | null;
 /** Which card this is: the transcript's or the question sheet's. Both draw the same state, so
  *  a focus request belongs to the one whose Other was clicked. */
 surface: "chat" | "sheet";
 /** Redraw after a change to `state`. */
 changed(): void;
 submit(values: Record<string, FieldValue>): void;
 terminal(): void;
}

function header(label: string, count: number, current: number): HTMLElement {
 const head = el("div", "ask-form-head");
 const bars = el("span", "ask-form-bars");
 bars.setAttribute("aria-hidden", "true");
 for (let i = 0; i < count; i++) bars.append(el("i", i < current ? "done" : i === current ? "current" : ""));
 head.append(el("span", "ask-form-step", label), bars);
 return head;
}

/** The open form: a field step, the review step, or the first field read-only. */
export function askFormCard(input: AskFormCardInput): HTMLElement[] {
 const { form, state } = input;
 const count = form.fields.length;
 const initial = formDraft(form);
 const draftOf = (field: AskFormField) => state.draft[field.name] ?? initial[field.name]!;
 const go = (step: number, fromReview = state.fromReview) => {
  state.step = step; state.fromReview = fromReview && step < count; state.shownProblem = null; state.version++;
  input.changed();
 };
 const nodes: HTMLElement[] = [];
 const readOnly = !input.answerable;
 const step = readOnly ? 0 : Math.min(state.step, count);

 if (step === count) {
  nodes.push(header("Review", count, count));
  nodes.push(el("p", "ask-form-title", "Check your answers"));
  const list = el("div", "ask-form-review");
  form.fields.forEach((field, index) => {
   const draft = draftOf(field);
   const row = button("ask-form-review-row", () => go(index, true));
   const text = el("span", "ask-form-review-text");
   const answer = fieldAnswer(field, draft);
   text.append(el("span", "ask-form-review-question", fieldQuestion(field)), el("span", answer ? "ask-form-review-answer" : "ask-form-review-answer none", answer || "No answer"));
   const meta = el("span", "ask-form-review-meta");
   if (fieldChanged(field, draft, initial[field.name]!)) meta.append(el("span", "", "Changed"));
   meta.append(symbolNow("chevron.right", 10, "bold"));
   row.append(text, meta);
   row.setAttribute("aria-label", `${fieldQuestion(field)}: ${answer || "No answer"}. Change`);
   list.append(row);
  });
  nodes.push(list);
  if (input.problem) nodes.push(el("p", "chat-question-problem", input.problem.message));
  if (input.problem?.offersTerminal) {
   nodes.push(button("chat-question-terminal", input.terminal, "Answer in Terminal"));
  } else {
   const submit = button("ask-form-submit", () => {
    const bad = firstProblem(form, state.draft);
    if (bad >= 0) { go(bad, true); state.shownProblem = form.fields[bad]!.name; input.changed(); return; }
    input.submit(formValues(form, state.draft));
   }, input.sending ? "Sending…" : "Submit");
   submit.disabled = input.sending;
   nodes.push(submit);
  }
  const foot = el("div", "ask-form-foot");
  const back = button("ask-form-link", () => go(count - 1, false));
  back.append(symbolNow("chevron.left", 10, "bold"), el("span", "", "Back"));
  back.disabled = input.sending;
  foot.append(back, el("span", "ask-form-hint", "Click an answer to change it"));
  nodes.push(foot);
  return nodes;
 }

 const field = form.fields[step]!;
 const draft = draftOf(field);
 const set = (next: typeof draft) => { state.draft = { ...state.draft, [field.name]: next }; };
 nodes.push(header(`${step + 1} of ${count}`, count, step));
 if (step === 0 && form.intro) nodes.push(el("p", "ask-form-intro", form.intro));
 if (field.title) nodes.push(el("p", "ask-form-title", field.title));
 if (field.description) nodes.push(el("p", "ask-form-description", field.description));

 // After a choice that finishes the field: the next field, or back to the review.
 const advance = () => go(state.fromReview ? count : step + 1);
 const next = () => {
  const problem = fieldProblem(field, draftOf(field));
  if (problem) { state.shownProblem = field.name; state.version++; input.changed(); return; }
  advance();
 };

 const options = el("div", "ask-form-options");
 if (field.kind === "choice") {
  for (const option of optionsOf(field)) {
   const chosen = !readOnly && draft.options.includes(option.value);
   const row = readOnly ? el("div", "ask-form-option readonly") : button(`ask-form-option${chosen ? " selected" : ""}`, () => {
    set(chooseOption(field, draftOf(field), option.value));
    if (field.multi) { state.shownProblem = null; state.version++; input.changed(); } else advance();
   });
   if (row instanceof HTMLButtonElement) {
    row.disabled = option.disabled === true || input.sending;
    row.setAttribute("aria-pressed", String(chosen));
   }
   row.append(el("span", "ask-form-option-label", option.label));
   if (option.checked) row.append(el("span", "ask-form-recommended", "Recommended"));
   options.append(row);
  }
  if (field.other) {
   if (readOnly) options.append(el("div", "ask-form-option readonly ghost", "Other…"));
   else if (draft.other === null) {
    options.append(button("ask-form-option ghost", () => { set(chooseOther(field, draftOf(field))); state.focusOther = input.surface; state.version++; input.changed(); }, "Other…"));
   } else {
    const other = el("label", "ask-form-other");
    const caption = field.multi ? button("ask-form-other-caption", () => { set(chooseOther(field, draftOf(field))); state.version++; input.changed(); }, "Other") : el("span", "ask-form-other-caption", "Other");
    if (field.multi) caption.setAttribute("aria-label", "Remove Other");
    // One line: herdr types it into omp's Other field, which takes no new lines.
    const box = el("input", "ask-form-input");
    box.type = "text"; box.value = draft.other; box.placeholder = "Type your answer";
    box.disabled = input.sending;
    box.oninput = () => set({ ...draftOf(field), other: box.value });
    box.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); next(); } };
    other.append(caption, box);
    options.append(other);
    if (state.focusOther === input.surface) {
     state.focusOther = null;
     requestAnimationFrame(() => { if (box.isConnected) box.focus(); });
    }
   }
  }
 } else {
  const multiline = field.input_type === "textarea";
  const box = multiline ? el("textarea", "ask-form-input") : el("input", "ask-form-input");
  if (box instanceof HTMLInputElement) {
   box.type = ["number", "email", "url", "date", "time", "datetime-local", "month", "week", "tel", "color", "range", "password"].includes(field.input_type ?? "") ? field.input_type! : "text";
   // Bounds before the value: a range clamps its value to the bounds it has when it's set.
   if (field.min != null) box.min = String(field.min);
   if (field.max != null) box.max = String(field.max);
  } else box.rows = 3;
  box.value = readOnly ? field.value ?? "" : draft.text;
  box.placeholder = field.placeholder ?? "";
  box.disabled = readOnly || input.sending;
  box.oninput = () => set({ ...draftOf(field), text: box.value });
  if (!multiline) box.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); next(); } };
  options.append(box);
 }
 nodes.push(options);
 if (readOnly) {
  if (input.waiting !== null) {
   const line = el("p", "chat-question-waiting");
   line.append(el("span", "chat-question-waiting-dot"), el("span", "", `WAITING FOR ${input.waiting.toUpperCase()} TO ANSWER`));
   nodes.push(line);
  } else {
   if (input.problem) nodes.push(el("p", "chat-question-problem", input.problem.message));
   nodes.push(button("chat-question-terminal", input.terminal, "Answer in Terminal"));
  }
  return nodes;
 }
 if (state.shownProblem === field.name) {
  const problem = fieldProblem(field, draftOf(field));
  if (problem) nodes.push(el("p", "ask-form-problem", problem));
 }
 const foot = el("div", "ask-form-foot");
 const back = button("ask-form-link", () => go(step - 1, false));
 back.append(symbolNow("chevron.left", 10, "bold"), el("span", "", "Back"));
 back.disabled = step === 0 || input.sending;
 // A single choice moves on when picked, so the footer offers the review; anything typed or
 // toggled needs Next (iPhone B-open, B-mid2).
 const typing = field.kind === "text" || field.multi || draft.other !== null;
 let forward: HTMLButtonElement;
 if (typing || state.fromReview) {
  forward = button("ask-form-next", next, state.fromReview ? "Done" : step === count - 1 ? "Review" : "Next");
 } else {
  forward = button("ask-form-link", () => {
   const bad = firstProblem(form, state.draft);
   go(bad >= 0 && bad < step ? bad : count, false);
  });
  forward.append(el("span", "", "Review all"), symbolNow("chevron.right", 10, "bold"));
 }
 forward.disabled = input.sending;
 foot.append(back, forward);
 nodes.push(foot);
 return nodes;
}

/** Who answered, as the card's check line says it. */
export type AnswerCredit = "you" | "anyone" | { owner: string };

/** The answers the owner's draft gives, worded as omp reports them: shown after a submit herdr
 *  sent but couldn't confirm (sent_unconfirmed), until the transcript's form_answer arrives. */
export function draftAnswers(form: AskForm, draft: FormDraft): AskFormAnswer[] {
 const initial = formDraft(form);
 return form.fields.map(field => ({ name: field.name, question: fieldQuestion(field), answer: fieldAnswer(field, draft[field.name] ?? initial[field.name]!) }));
}

/** The answered form: the intro, "You answered 6 of 6" and one line per answer (iPhone B-done).
 *  `sent`: herdr typed the answers but hasn't seen omp's result yet ("Sent"). */
export function askFormAnswered(form: AskForm | null, answers: AskFormAnswer[], status: AskFormStatus | null, credit: AnswerCredit, sent = false): HTMLElement[] {
 const nodes: HTMLElement[] = [];
 if (form?.intro) nodes.push(el("p", "ask-form-answered-intro", form.intro));
 const total = form?.fields.length || answers.length;
 const given = answers.filter(answer => answer.answer.trim() !== "");
 const head = el("p", "ask-form-answered-head");
 if (sent) head.append(symbolNow("checkmark", 12, "semibold"), el("span", "", "Sent"));
 else if (status === "timed_out" && !given.length) head.append(el("span", "", "Timed out without an answer"));
 else if (status === "cancelled" && !given.length) head.append(el("span", "", "Not answered"));
 else {
  const who = credit === "you" ? "You answered" : credit === "anyone" ? "Answered" : `${credit.owner} answered`;
  head.append(symbolNow("checkmark", 12, "semibold"), el("span", "", `${who} ${given.length} of ${total}`));
 }
 nodes.push(head);
 answers.forEach((answer, index) => {
  if (!answer.answer.trim()) return;
  const row = el("p", "ask-form-answered-row");
  row.title = `${answer.question}: ${answer.answer}`;
  row.append(el("span", "ask-form-answered-number", String(index + 1)), el("span", "ask-form-answered-text", answer.answer));
  nodes.push(row);
 });
 return nodes;
}
