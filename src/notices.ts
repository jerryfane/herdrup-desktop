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
