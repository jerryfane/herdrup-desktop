package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// Like the native reference's picked-file fixture, replace only the OS chooser's
// result. The paperclip, staging, uploader and SSH daemon remain production paths.
func prepareGramReference(desk *Desk, state string) (func(), error) {
	if state != "gram-composer-attachment" && state != "gram-composer-ambiguous" {
		return func() {}, nil
	}
	raw, err := os.ReadFile(os.Getenv("HERDRUP_REF_FIXTURE"))
	if err != nil {
		return nil, err
	}
	var fixture struct {
		File struct {
			Name   string `json:"name"`
			Data   string `json:"data_base64"`
			SHA256 string `json:"sha256"`
			Size   int    `json:"size"`
		} `json:"gram.upload.fixture"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(fixture.File.Data)
	if err != nil {
		return nil, err
	}
	if fixture.File.Name == "" || filepath.Base(fixture.File.Name) != fixture.File.Name || len(data) != fixture.File.Size || fmt.Sprintf("%x", sha256.Sum256(data)) != fixture.File.SHA256 {
		return nil, fmt.Errorf("reference picked file does not match its manifest")
	}
	dir, err := os.MkdirTemp("", "herdrup-reference-picked-")
	if err != nil {
		return nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	path := filepath.Join(dir, fixture.File.Name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		cleanup()
		return nil, err
	}
	desk.openDialog = func(context.Context) ([]string, error) { return []string{path}, nil }
	return cleanup, nil
}

func driveGramReference(desk *Desk, win *mygo.Window, state string) (bool, string) {
	if !strings.HasPrefix(state, "gram-") {
		return true, "ready"
	}
	encoded, _ := json.Marshal(state)
	// Saved references prepare the real local saved store, not renderer content.
	// Context-menu acceptance is separate from this deterministic capture setup.
	if state == "gram-saved" {
		// The owner inbox starts on first opening Gram, not on SSH connect.
		if _, err := win.Page().Eval(`const tab = [...document.querySelectorAll('.t-tab-label')].find(el => el.textContent === "Gram"); if (!tab) throw new Error("Gram tab missing"); tab.click(); return true`); err != nil {
			return false, err.Error()
		}
		deadline := time.Now().Add(15 * time.Second)
		for desk.GramState().Phase != "loaded" {
			if time.Now().After(deadline) {
				return false, "reference inbox did not load before saving"
			}
			time.Sleep(50 * time.Millisecond)
		}
		for _, id := range []string{"gr-owner", "gr-file"} {
			if err := desk.GramSetSaved(id, true); err != nil {
				return false, err.Error()
			}
		}
	}
	value, err := win.Page().Eval(`return await (async () => {
  const state = ` + string(encoded) + `;
  const until = async (read, label) => {
    const end = performance.now() + 15000;
    while (performance.now() < end) {
      if (read()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(state + ": " + label);
  };
  const text = () => document.getElementById("detail").textContent;
  const row = id => document.querySelector('.gslot[data-id="' + id + '"]');
  const tab = [...document.querySelectorAll('.t-tab-label')].find(el => el.textContent === "Gram");
  if (!tab) throw new Error("Gram tab missing");
  localStorage.setItem("gram.setupCardDismissed", "1");
  tab.click();
  await until(() => document.querySelector('.gfield-input'), "Gram composer mounted");
  const dismiss = document.querySelector('.gsetup-close');
  if (dismiss) dismiss.click();
  if (state === "gram-loading") {
    await until(() => document.querySelector('.gspinner') && !document.querySelector('.gram-scroll') && !text().includes("No messages yet"), "pending first fetch");
    document.querySelectorAll('.gspinner *').forEach(el => el.getAnimations().forEach(animation => animation.pause()));
  } else if (state === "gram-empty") {
    await until(() => text().includes("No messages yet") && !text().includes("No matches"), "empty inbox");
  } else {
    await until(() => row("gr-owner") && row("gr-file"), "loaded reference inbox");
    if (state === "gram-saved") {
      document.querySelector('.gsaved-toggle').click();
      await until(() => document.querySelector('.gram-scroll[data-kind="saved"]') && row("gr-owner") && row("gr-file"), "saved messages");
    } else if (state.startsWith("gram-search-")) {
      const field = document.querySelector('.gsearch input');
      field.value = state === "gram-search-results" ? "handoff" : "no-such-reference";
      field.dispatchEvent(new Event("input", {bubbles:true}));
      field.blur();
      await until(() => !row("gr-owner") && (state === "gram-search-results" ? row("gr-file") : text().includes("No matches")), "filtered inbox");
    } else if (state.startsWith("gram-composer-")) {
      document.querySelector('[aria-label="Attach file"]').click();
      await until(() => document.querySelector('.gchip-name')?.textContent === "picked-notes.txt" && document.querySelector('.gchip-status')?.textContent.endsWith(" · Ready"), "picked attachment uploaded");
      const field = document.querySelector('.gfield-input');
      const input = value => { field.value = value; field.setSelectionRange(value.length, value.length); field.dispatchEvent(new Event("input", {bubbles:true})); };
      if (state === "gram-composer-attachment") {
        input("@vet");
        await until(() => document.querySelector('.gmention-row'), "mention picker");
        const mention = [...document.querySelectorAll('.gmention-row')].find(el => el.textContent.includes("vetrina"));
        if (!mention) throw new Error("vetrina mention missing");
        mention.click();
        input(field.value + "Please review the attached notes.");
        await until(() => document.querySelector('[aria-label="Send gram"]')?.disabled === false, "resolved recipient enables send");
      } else {
        input("@clientloop Please review the attachment.");
        await until(() => document.querySelector('.ghint').textContent.includes("Several agents are called clientloop"), "ambiguous recipient hint");
        await until(() => document.querySelector('[aria-label="Send gram"]')?.disabled === true, "ambiguous recipient disables send");
      }
      field.blur();
    } else if (state !== "gram-mixed-latest") {
      const id = {"gram-mixed-image":"gr-image", "gram-mixed-folded":"gr-long", "gram-mixed-code":"gr-code"}[state];
      await until(() => row(id), "older message exists");
      if (state === "gram-mixed-image") await until(() => row(id).querySelector('img.gimage-pic')?.naturalWidth > 0, "image bytes decoded");
      if (state === "gram-mixed-folded") await until(() => [...row(id).querySelectorAll('.gfold')].some(el => !el.hidden && el.textContent.includes("Read more")), "eleven-line report folded");
      if (state === "gram-mixed-code") await until(() => row(id).querySelector('[aria-label="Copy code"]'), "multiline code copy");
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const feed = document.querySelector('.gram-scroll');
      const target = () => row(id)?.querySelector(state === "gram-mixed-image" ? ".gimage" : ".gparts");
      const visible = () => {
        const node = target();
        if (!node || !feed) return false;
        const rect = node.getBoundingClientRect(), viewport = feed.getBoundingClientRect();
        const top = document.querySelector('.gpill')?.getBoundingClientRect().bottom ?? viewport.top;
        return rect.width > 0 && rect.height > 0 && rect.top >= top && rect.bottom <= viewport.bottom &&
          node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      };
      // DesktopGramReferenceShots reveals only clipped targets, in 160 pt steps.
      for (let attempt = 0; attempt < 18 && !visible(); attempt++) {
        if (!feed) throw new Error("Gram feed missing while revealing an older message");
        feed.scrollTop -= 160;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      if (!visible()) throw new Error("The complete reference message is not visible below the floating header");
    }
  }
  await until(() => {
    const viewport = document.querySelector('.gram-scroll')?.getBoundingClientRect();
    if (!viewport) return true;
    return [...document.querySelectorAll('.gimage')].every(card => {
      const rect = card.getBoundingClientRect();
      return rect.bottom <= viewport.top || rect.top >= viewport.bottom || card.querySelector('img.gimage-pic')?.naturalWidth > 0;
    });
  }, "visible image previews decoded");
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`)
	if err != nil {
		return false, err.Error()
	}
	if value != true {
		return false, fmt.Sprintf("Gram reference returned %v", value)
	}
	return true, "ready"
}
