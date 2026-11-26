/** The window's notices, the Topics switch's (agentActions.ts) and a browser asking to be approved
 *  (webAccess.ts): one region at the window's level, so no pane's hidden or inert state reaches
 *  them, as the minimised sidebar's would (#486). style.css .notices places it: over the
 *  sidebar's foot, above the tab bar, while the sidebar shows; across the window's bottom while
 *  the minimised sidebar's rail or a phone's page covers the sidebar, the detail ending above it.
 *
 *  Made with its measure: --foot-notice on the root follows the room the notices take, as the
 *  observer measures the region's content box, as they come, go and rewrap. The sidebar's lists
 *  end above them (style.css .roster, gram.css, settings.css, guest.css), and so does the detail
 *  where they cross the window's bottom (style.css). No notice sits in an unmeasured region. */
export function noticeRegion(): HTMLElement {
  let region = document.getElementById("notices");
  if (!region) {
    region = document.createElement("div");
    region.id = "notices"; region.className = "notices";
    document.body.append(region);
    new ResizeObserver(entries => {
      for (const { contentBoxSize: [box] } of entries) if (box) document.documentElement.style.setProperty("--foot-notice", `${box.blockSize}px`);
    }).observe(region);
  }
  return region;
}

/** The words after a share went into the HerdrUp account (frame com-g3). */
export const accountShareNotice = (agentName: string) => `${agentName} is in your HerdrUp account. Sign in on your other devices to open it there.`;

let accountNotice: HTMLElement | null = null;
/** After an accept that put the share in the account (Access.accountBound): one quiet line among
 *  the window's notices, with OK, until read. A second accept replaces the first's. */
export function showAccountShareNotice(agentName: string): HTMLElement {
  return showAccountNotice(accountShareNotice(agentName));
}

/** The account notice with words of its own: the browser's after an accept it bound, which says
 *  whether the account took the share (web/shares.ts boundNotice). */
export function showAccountNotice(words: string): HTMLElement {
  const region = noticeRegion();
  accountNotice?.remove();
  const notice = document.createElement("div");
  notice.className = "account-share-notice"; notice.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "account-share-notice-text"; text.textContent = words;
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "button-secondary button-compact"; ok.textContent = "OK";
  ok.onclick = () => notice.remove();
  notice.append(text, ok);
  region.prepend(notice);
  accountNotice = notice;
  return notice;
}
