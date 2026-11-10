package fakeherdr

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// Ask-form modes for the interaction fixture (herdr ask-form contract,
// 2026-11-10): the pending ask is an omp HTML form instead of a question.
const (
	// AskFormAnswerable: ping advertises ask_form and the form is answerable.
	AskFormAnswerable = "answerable"
	// AskFormReadOnly: form_answerable is false, as herdr makes a form with a
	// <textarea> (herdr #392 r5: omp's editor can't be cleared safely); its
	// notes field is that textarea, prefilled.
	AskFormReadOnly = "readonly"
	// AskFormMoved: agent.answer_form answers ask_form_moved, as when
	// someone is answering in the Terminal.
	AskFormMoved = "moved"
	// AskFormOldHost: the form arrives but ping lacks ask_form.
	AskFormOldHost = "old-host"
)

// SetAskForm makes the pending ask an HTML form in mode (one of the
// AskForm* constants), or the plain question for "".
func (x *Interaction) SetAskForm(mode string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.form = mode
}

// AskFormCapability reports whether ping advertises ask_form.
func (x *Interaction) AskFormCapability() bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.form != "" && x.form != AskFormOldHost
}

type formOption struct {
	Value, Label string
	Checked      bool
}

type formField struct {
	Name, Kind, Title, Description string
	Multi, Select, Other, Required bool
	Options                        []formOption
	InputType, Placeholder         string
}

const askFormIntro = "Before enyo-ui starts building from iteration 5, a few choices. My recommendation is preselected."

// askFormFields is the lenscale example the owner picked the stepper from
// (herdrup-ask-form-proposals.html, section B), adapted to every control kind.
var askFormFields = []formField{
	{Name: "where", Kind: "choice", Title: "Where to build", Other: true,
		Description: "lenscale.ai is public today (the 1 Nov landing). preview.lenscale.ai already sits behind Cloudflare Zero Trust with Jerry, Nicola and @lenscale.ai allowed.",
		Options: []formOption{
			{"preview", "preview.lenscale.ai: already hidden, no Cloudflare change; lenscale.ai keeps the current landing until you say launch", true},
			{"apex", "lenscale.ai behind Zero Trust: hides the current public landing too", false},
			{"staging", "A new staging.lenscale.ai: new hostname and DNS record", false},
		}},
	{Name: "who", Kind: "choice", Title: "Who may see it", Multi: true, Other: true, Options: []formOption{
		{"jerry", "Your Gmail", true}, {"nicola", "Nicola's Gmail", true}, {"team", "Any @lenscale.ai address", true},
	}},
	{Name: "order", Kind: "choice", Title: "What to build first", Other: true, Options: []formOption{
		{"site", "The public site (pages 01–13) first; the app pages (14–24) next", true},
		{"app", "The app pages first", false},
	}},
	{Name: "fonts", Kind: "choice", Title: "Fonts", Select: true, Options: []formOption{
		{"geist", "Geist, as the mockups", true}, {"inter", "Inter", false},
	}},
	{Name: "demo", Kind: "choice", Title: "Where 'Book a demo' requests go", Other: true, Required: true, Options: []formOption{
		{"dashboard", "A row in the Team dashboard (Partners) and a Gram to you", true},
		{"email", "Email to an @lenscale.ai inbox (write which in Other)", false},
	}},
	{Name: "notes", Kind: "text", Title: "Anything else", InputType: "text", Placeholder: "Optional"},
}

// askFormJSON is the form as herdr reports it; readOnly makes the notes field
// the prefilled textarea that leaves herdr unable to answer.
func askFormJSON(readOnly bool) map[string]any {
	fields := make([]any, len(askFormFields))
	for i, f := range askFormFields {
		options := make([]any, len(f.Options))
		for j, o := range f.Options {
			options[j] = map[string]any{"value": o.Value, "label": o.Label, "checked": o.Checked, "disabled": false}
		}
		field := map[string]any{"name": f.Name, "kind": f.Kind, "title": f.Title, "multi": f.Multi, "select": f.Select,
			"other": f.Other, "required": f.Required, "options": options}
		if f.Description != "" {
			field["description"] = f.Description
		}
		if f.Kind == "text" {
			field["input_type"], field["placeholder"], field["value"] = f.InputType, f.Placeholder, ""
			if readOnly {
				field["input_type"], field["value"] = "textarea", "Ship after the review.\nNo launch post yet."
			}
		}
		fields[i] = field
	}
	return map[string]any{"intro": askFormIntro, "fields": fields}
}

// askFormQuestions is the old-app fallback: one AskQuestion per choice field.
func askFormQuestions() []any {
	var out []any
	for _, f := range askFormFields {
		if f.Kind != "choice" {
			continue
		}
		labels := make([]string, len(f.Options))
		q := map[string]any{"question": f.Title, "multi": f.Multi}
		for j, o := range f.Options {
			labels[j] = o.Label
			if o.Checked && !f.Multi {
				q["recommended"] = j
			}
		}
		q["options"] = labels
		out = append(out, q)
	}
	return out
}

type formValue struct {
	Options []string `json:"options"`
	Other   *string  `json:"other"`
	Text    *string  `json:"text"`
}

// answerForm validates values as herdr does (contract: agent.answer_form)
// and returns omp's answers, one per field.
func answerForm(values map[string]formValue) ([]map[string]any, *APIError) {
	for name := range values {
		if !slices.ContainsFunc(askFormFields, func(f formField) bool { return f.Name == name }) {
			return nil, &APIError{Code: "ask_form_invalid", Message: fmt.Sprintf("%s: no such field", name)}
		}
	}
	var answers []map[string]any
	for _, f := range askFormFields {
		v, given := values[f.Name]
		var answer string
		if f.Kind == "text" {
			if given && v.Text != nil {
				answer = *v.Text
			}
		} else {
			chosen := []string{}
			if given {
				chosen = v.Options
			} else {
				for _, o := range f.Options {
					if o.Checked {
						chosen = append(chosen, o.Value)
					}
				}
			}
			var labels []string
			for _, value := range chosen {
				i := slices.IndexFunc(f.Options, func(o formOption) bool { return o.Value == value })
				if i < 0 {
					return nil, &APIError{Code: "ask_form_invalid", Message: fmt.Sprintf("%s: no option %q", f.Name, value)}
				}
				labels = append(labels, f.Options[i].Label)
			}
			other := ""
			if given && v.Other != nil {
				other = strings.TrimSpace(*v.Other)
			}
			if other != "" {
				if !f.Other {
					return nil, &APIError{Code: "ask_form_invalid", Message: f.Name + ": no Other"}
				}
				labels = append(labels, "Other: "+other)
			}
			// A radio named in values takes exactly one option or Other; a
			// checkbox group named with none chose none (herdr-app 447167).
			if !f.Multi && (len(labels) > 1 || given && len(labels) == 0) {
				return nil, &APIError{Code: "ask_form_invalid", Message: f.Name + ": pick exactly one option or Other"}
			}
			answer = strings.Join(labels, ", ")
		}
		if f.Required && answer == "" {
			return nil, &APIError{Code: "ask_form_invalid", Message: f.Name + ": required"}
		}
		answers = append(answers, map[string]any{"name": f.Name, "question": f.Title, "answer": answer})
	}
	return answers, nil
}

// handleAskForm serves agent.answer_form; x.mu is held.
func (x *Interaction) handleAskForm(raw json.RawMessage) (any, *APIError) {
	var p struct {
		AskID  string               `json:"ask_id"`
		Values map[string]formValue `json:"values"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &APIError{Code: "invalid_request", Message: err.Error()}
	}
	switch {
	case x.answered || p.AskID != "q1":
		return nil, &APIError{Code: "ask_not_pending", Message: "The question is no longer pending"}
	case x.form == AskFormMoved:
		return nil, &APIError{Code: "ask_form_moved", Message: "The terminal form is not in its starting state"}
	case x.form == AskFormReadOnly:
		return nil, &APIError{Code: "ask_unsupported", Message: "The form has controls herdr can't drive"}
	}
	answers, problem := answerForm(p.Values)
	if problem != nil {
		return nil, problem
	}
	lines := make([]string, len(answers))
	for i, a := range answers {
		lines[i] = fmt.Sprintf("%s: %s", a["question"], a["answer"])
	}
	x.entries = append(x.entries, map[string]any{
		"kind": "ask", "id": "q1", "ts_ms": 5, "questions": askFormQuestions(), "answer": lines,
		"form": askFormJSON(false), "form_answer": answers, "form_status": "answered",
	})
	x.answered = true
	return map[string]any{"type": "ask_form_answered", "status": "answered", "answers": answers}, nil
}
