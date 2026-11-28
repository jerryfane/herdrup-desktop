import { expect, test } from "bun:test";
import { parseGramMessage } from "../src/gramMarkdown";

test("single paragraph stays non-rich and preserves single-newline breaks", () => {
  const msg = "Deployed. vetrina.dev is live.\n• Build 412 passed\n• 2 migrations ran clean";
  const blocks = parseGramMessage(msg);
  expect(blocks.length).toBe(1);
  const block = blocks[0]!;
  expect(block.kind).toBe("markdown");
  if (block.kind !== "markdown") return;
  expect(block.rich).toBe(false);
  expect(block.hasTable).toBe(false);
  expect(block.html).toContain("<br>");
  expect(block.html).toContain("Build 412 passed");
});

test("paragraphs, headings, unordered/ordered/task lists, quotes, rules, and inline styles render as rich markdown", () => {
  const md = [
    "## Release summary",
    "",
    "Shipped **v1.2** with *zero* downtime and `herdr` update.",
    "",
    "Second paragraph with ~~old~~ [docs](https://herdrup.app) and https://guest.herdrup.app.",
    "",
    "- First item",
    "- Second item",
    "  - Nested detail",
    "- [x] Merged",
    "- [ ] Follow-up",
    "",
    "1. Step one",
    "2. Step two",
    "",
    "> Quoted note",
    "",
    "---",
  ].join("\n");
  const blocks = parseGramMessage(md);
  expect(blocks.length).toBe(1);
  const block = blocks[0]!;
  expect(block.kind).toBe("markdown");
  if (block.kind !== "markdown") return;
  expect(block.rich).toBe(true);
  expect(block.hasTable).toBe(false);
  expect(block.html).toContain("<h2>Release summary</h2>");
  expect(block.html).toContain("<strong>v1.2</strong>");
  expect(block.html).toContain("<em>zero</em>");
  expect(block.html).toContain("<code>herdr</code>");
  expect(block.html).toContain("<del>old</del>");
  expect(block.html).toContain('href="https://herdrup.app"');
  expect(block.html).toContain('href="https://guest.herdrup.app"');
  expect(block.html).toContain("<ul>");
  expect(block.html).toContain("<ol>");
  expect(block.html).toContain('class="gcheck checked"');
  expect(block.html).toContain('class="gcheck unchecked"');
  expect(block.html).not.toContain("<input");
  expect(block.html).toContain("<blockquote>");
  expect(block.html).toContain("<hr>");
});

test("GFM tables are detected and rendered with alignment; stray pipes stay plain paragraphs", () => {
  const table = [
    "Results:",
    "",
    "| Service | Latency | Delta |",
    "|---|:---:|---:|",
    "| API | 42ms | +12% |",
    "| Relay | 18ms | -4% |",
  ].join("\n");
  const blocks = parseGramMessage(table);
  expect(blocks.length).toBe(1);
  const block = blocks[0]!;
  expect(block.kind).toBe("markdown");
  if (block.kind !== "markdown") return;
  expect(block.rich).toBe(true);
  expect(block.hasTable).toBe(true);
  expect(block.html).toContain("<table>");
  expect(block.html).toContain("<th>Service</th>");
  expect(block.html).toContain('<td align="center">42ms</td>');
  expect(block.html).toContain('<td align="right">+12%</td>');

  const stray = parseGramMessage("plain prose with a | pipe");
  expect(stray).toHaveLength(1);
  expect(stray[0]).toMatchObject({ kind: "markdown", rich: false, hasTable: false });
});

test("nested tables inside blockquotes are detected", () => {
  const blocks = parseGramMessage("> | A | B |\n> |---|---|\n> | 1 | 2 |");
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ kind: "markdown", rich: true, hasTable: true });
});

test("whole-message parsing preserves indented list fences, tilde fences containing backticks, and cross-fence reference links", () => {
  // 1. Indented backtick fence inside a list item stays one single list with continuation inside the item,
  //    and retains exact parsed code text (including a trailing blank line) for Copy.
  const nestedList = [
    "- Run build:",
    "  ```sh",
    "  make test",
    "",
    "  ```",
    "  Then verify output.",
    "- Deploy",
  ].join("\n");
  const listBlocks = parseGramMessage(nestedList);
  expect(listBlocks).toHaveLength(1);
  expect(listBlocks[0]!.kind).toBe("markdown");
  if (listBlocks[0]!.kind === "markdown") {
    expect((listBlocks[0]!.html.match(/<ul>/g) ?? []).length).toBe(1);
    expect(listBlocks[0]!.html).toContain("Then verify output.");
    expect(listBlocks[0]!.html).toContain("<pre><code");
    expect(listBlocks[0]!.codes).toEqual([{ code: "make test\n", language: "sh" }]);
  }

  // 2. Tilde-fenced Markdown example containing literal backticks stays one single top-level code block.
  const tildeExample = "~~~md\nExample:\n```sh\necho hi\n```\n~~~";
  expect(parseGramMessage(tildeExample)).toEqual([
    { kind: "code", code: "Example:\n```sh\necho hi\n```", language: "md" },
  ]);

  // 3. Reference link whose definition sits after a code block resolves cleanly with no trailing empty block.
  const refMsg = "Read [Guide][docs].\n\n```sh\nmake\n```\n\n[docs]: https://herdrup.app/docs";
  const refBlocks = parseGramMessage(refMsg);
  expect(refBlocks).toHaveLength(2);
  expect(refBlocks[0]!.kind).toBe("markdown");
  if (refBlocks[0]!.kind === "markdown") {
    expect(refBlocks[0]!.html).toContain('href="https://herdrup.app/docs"');
    expect(refBlocks[0]!.html).toContain(">Guide</a>");
  }
  expect(refBlocks[1]).toEqual({ kind: "code", code: "make", language: "sh" });
});

test("bare www autolinks upgrade to https while preserving case, query entities, emails, and explicit http destinations", () => {
  const msg = '-ops@example.test, _ops@example.test (unformatted), Send to ...ops@example.test, +ops@example.test and +ops@example.test, _ops@example.test_, Email ops@example.test: or docs@example.test?, Did you email www.ops@example.com? Email www.ops@example.com: ask, See cowww.example.test or coWWW.example.test and cohttps://example.test, Bare "WWW.Example.com/Runbook" and "www.example.test", Docs:https://example.test/api?cursor=ready; and frag https://example.test/#faq?mode; or `docs`www.example.test, query www.example.com/?q=1&copy;more and www.example.test/?q=1&amp; vs prose www.example.test; next, ftp://www.example.test/releases and ftp://ops@example.test/releases, email ops+www.alerts@example.com, team.www.alerts@example.com, www.ops@example.com,www.team@example.org or <docs@example.test>, url-with-at www.ops@example.com/report and www.ops@example.com?x=1 and www.ops@example.com:8080 and www.ops@example.com#top, explicit [www.example.com](http://www.example.com) and <http://www.example.com>.';
  const blocks = parseGramMessage(msg);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.kind).toBe("markdown");
  if (blocks[0]!.kind !== "markdown") return;
  expect(blocks[0]!.html).toContain('<a href="mailto:-ops@example.test">-ops@example.test</a>');
  expect(blocks[0]!.html).toContain('<a href="mailto:_ops@example.test">_ops@example.test</a> (unformatted)');
  expect(blocks[0]!.html).toContain('Send to ...<a href="mailto:ops@example.test">ops@example.test</a>');
  expect(blocks[0]!.html).toContain('<a href="mailto:+ops@example.test">+ops@example.test</a> and <a href="mailto:+ops@example.test">+ops@example.test</a>');
  expect(blocks[0]!.html).toContain('<em><a href="mailto:ops@example.test">ops@example.test</a></em>');
  expect(blocks[0]!.html).toContain('Email <a href="mailto:ops@example.test">ops@example.test</a>: or <a href="mailto:docs@example.test">docs@example.test</a>?');
  expect(blocks[0]!.html).toContain('Did you email <a href="mailto:www.ops@example.com">www.ops@example.com</a>? Email <a href="mailto:www.ops@example.com">www.ops@example.com</a>: ask,');
  expect(blocks[0]!.html).toContain('See cowww.example.test or coWWW.example.test and cohttps://example.test,');
  expect(blocks[0]!.html).toContain('Bare &quot;<a href="https://WWW.Example.com/Runbook">WWW.Example.com/Runbook</a>&quot;');
  expect(blocks[0]!.html).toContain('and &quot;<a href="https://www.example.test">www.example.test</a>&quot;');
  expect(blocks[0]!.html).toContain('Docs:<a href="https://example.test/api?cursor=ready;">https://example.test/api?cursor=ready;</a>');
  expect(blocks[0]!.html).toContain('frag <a href="https://example.test/#faq?mode">https://example.test/#faq?mode</a>;');
  expect(blocks[0]!.html).toContain('<code>docs</code><a href="https://www.example.test">www.example.test</a>');
  expect(blocks[0]!.html).toContain('query <a href="https://www.example.com/?q=1&amp;copy;more">www.example.com/?q=1&amp;copy;more</a>');
  expect(blocks[0]!.html).toContain('and <a href="https://www.example.test/?q=1&amp;amp;">www.example.test/?q=1&amp;amp;</a>');
  expect(blocks[0]!.html).toContain('prose <a href="https://www.example.test">www.example.test</a>; next');
  expect(blocks[0]!.html).toContain('next, ftp://www.example.test/releases and ftp://ops@example.test/releases, email');
  expect(blocks[0]!.html).toContain('<a href="mailto:ops+www.alerts@example.com">ops+www.alerts@example.com</a>');
  expect(blocks[0]!.html).toContain('<a href="mailto:team.www.alerts@example.com">team.www.alerts@example.com</a>');
  expect(blocks[0]!.html).toContain('<a href="mailto:www.ops@example.com">www.ops@example.com</a>,<a href="mailto:www.team@example.org">www.team@example.org</a>');
  expect(blocks[0]!.html).toContain('or <a href="mailto:docs@example.test">docs@example.test</a>');
  expect(blocks[0]!.html).toContain('url-with-at <a href="https://www.ops@example.com/report">www.ops@example.com/report</a> and <a href="https://www.ops@example.com?x=1">www.ops@example.com?x=1</a> and <a href="https://www.ops@example.com:8080">www.ops@example.com:8080</a> and <a href="https://www.ops@example.com#top">www.ops@example.com#top</a>');
  expect(blocks[0]!.html).toContain('explicit <a href="http://www.example.com">www.example.com</a>');
  expect(blocks[0]!.html).toContain('and <a href="http://www.example.com">http://www.example.com</a>');

  // Authored link and image labels preserve Markdown formatting even around `cohttps://` and `ftp://` (#670),
  // while plain-prose FTP/glued URLs with brackets never expose clickable suffixes (#672).
  const formattedLabels = parseGramMessage('[cohttps://**docs**.example.test](https://out.example.test) and [ftp://`code`.test](https://out.example.test/2) and ![ftp://`&amp;`](https://img.example.test/ftp)');
  expect(formattedLabels).toHaveLength(1);
  expect(formattedLabels[0]!.kind).toBe("markdown");
  if (formattedLabels[0]!.kind === "markdown") {
    expect(formattedLabels[0]!.html).toContain('<a href="https://out.example.test">cohttps://<strong>docs</strong>.example.test</a>');
    expect(formattedLabels[0]!.html).toContain('<a href="https://out.example.test/2">ftp://<code>code</code>.test</a>');
    expect(formattedLabels[0]!.html).toContain('<a href="https://img.example.test/ftp">ftp://&amp;amp;</a>');
  }
  const ftpBrackets = parseGramMessage("ftp://[2001:db8::1]/report@example.test and ftp://files.example.test/get?file=[www.example.test] and cohttps://[www.example.test]");
  expect(ftpBrackets).toHaveLength(1);
  expect(ftpBrackets[0]!.kind).toBe("markdown");
  if (ftpBrackets[0]!.kind === "markdown") {
    expect(ftpBrackets[0]!.html).not.toContain("<a ");
    expect(ftpBrackets[0]!.html).toContain("ftp://[2001:db8::1]/report@example.test");
    expect(ftpBrackets[0]!.html).toContain("ftp://files.example.test/get?file=[www.example.test]");
    expect(ftpBrackets[0]!.html).toContain("cohttps://[www.example.test]");
  }
  // Rejected FTP/glued URLs never swallow adjacent authored Markdown links, code spans, or emphasis (#674),
  // preserve literal query entity spellings, stay suppressed across nested emphasis (#677), and never
  // leak suppression into later paragraphs, list items, or table cells (#676).
  const adjacentMarkdown = parseGramMessage([
    'ftp://files.example.test[runbook](https://docs.example.test/runbook) and cohttps://files.example.test[guide](https://docs.example.test/guide) and ftp://files.example.test`code` and cohttps://**docs**.example.test https://ok.example.test',
    '',
    'ftp://files.example.test/[**docs**]/report@example.test after and cohttps://files.example.test/[**docs**]/report@example.test after and ftp://files.example.test/**www.example.test** **https://after.example.test**',
    '',
    'ftp://host/**note https://example.test** and cohttps://host/**note https://glued.example.test** and ftp://host/`a b`**www.aftercode.test**',
    '',
    'ftp://files.example.test/get?q=1&amp;mode=2 and &amp;',
    '',
    'ftp://www.example.test',
    '',
    'www.example.test',
    '',
    '- cohttps://example.test',
    '- https://example.test',
    '',
    '| A | B |',
    '|---|---|',
    '| ftp://www.example.test | www.example.test |',
  ].join('\n'));
  expect(adjacentMarkdown).toHaveLength(1);
  expect(adjacentMarkdown[0]!.kind).toBe("markdown");
  if (adjacentMarkdown[0]!.kind === "markdown") {
    const html = adjacentMarkdown[0]!.html;
    expect(html).toContain('ftp://files.example.test<a href="https://docs.example.test/runbook">runbook</a>');
    expect(html).toContain('cohttps://files.example.test<a href="https://docs.example.test/guide">guide</a>');
    expect(html).toContain('ftp://files.example.test<code>code</code>');
    expect(html).toContain('cohttps://<strong>docs</strong>.example.test <a href="https://ok.example.test">https://ok.example.test</a>');
    expect(html).toContain('ftp://files.example.test/[<strong>docs</strong>]/report@example.test after');
    expect(html).toContain('cohttps://files.example.test/[<strong>docs</strong>]/report@example.test after');
    expect(html).toContain('ftp://files.example.test/<strong>www.example.test</strong> <strong><a href="https://after.example.test">https://after.example.test</a></strong>');
    expect(html).toContain('ftp://host/<strong>note <a href="https://example.test">https://example.test</a></strong>');
    expect(html).toContain('cohttps://host/<strong>note <a href="https://glued.example.test">https://glued.example.test</a></strong>');
    expect(html).toContain('ftp://host/<code>a b</code><strong><a href="https://www.aftercode.test">www.aftercode.test</a></strong>');
    expect(html).toContain('ftp://files.example.test/get?q=1&amp;amp;mode=2 and &amp;');
    expect(html).toContain('<p><a href="https://www.example.test">www.example.test</a></p>');
    expect(html).toContain('<li><a href="https://example.test">https://example.test</a></li>');
    expect(html).toContain('<td><a href="https://www.example.test">www.example.test</a></td>');
  }
});

test("raw angle-bracket placeholders, Markdown images, and linked badges preserve readable text and authored destinations", () => {
  const placeholder = parseGramMessage("Deploy using <environment> before 5pm.");
  expect(placeholder).toHaveLength(1);
  expect(placeholder[0]!.kind).toBe("markdown");
  if (placeholder[0]!.kind === "markdown") {
    expect(placeholder[0]!.html).toContain("Deploy using &lt;environment&gt; before 5pm.");
  }

  const imageOnly = parseGramMessage("![Write `&amp;` to encode &amp; & <env>](https://example.com/chart.png?a=1\\&amp;&b=2\\&copy;&c=&#59;&d=&#X3B;)");
  expect(imageOnly).toHaveLength(1);
  expect(imageOnly[0]!.kind).toBe("markdown");
  if (imageOnly[0]!.kind === "markdown") {
    expect(imageOnly[0]!.html).not.toContain("<img");
    expect(imageOnly[0]!.html).toContain('<a href="https://example.com/chart.png?a=1&amp;amp;&amp;b=2&amp;copy;&amp;c=&#59;&amp;d=&#X3B;">Write &amp;amp; to encode &amp; &amp; &lt;env&gt;</a>');
  }

  // Escaped brackets, trailing parens, padded labels, Unicode STRAẞE folding, and rejected list
  // definitions all preserve the exact accepted raw destination (#661, #664, #665, #666).
  const escapedBrackets = parseGramMessage([
    "- intro",
    "  [art]: https://example.test/wrong",
    "",
    "![Badge](https://example.test/right)) and ![Build \\[linux\\]](https://example.test/img?q=\\&copy;) and ![Build \\[linux\\]][  STRAẞE  ] and ![Badge][  art  ]",
    "",
    "[art]: https://example.test/right?q=\\&copy;",
    "[STRASSE]: https://example.test/ref?q=\\&copy;&x=&#X3B;",
  ].join("\n"));
  expect(escapedBrackets).toHaveLength(1);
  expect(escapedBrackets[0]!.kind).toBe("markdown");
  if (escapedBrackets[0]!.kind === "markdown") {
    expect(escapedBrackets[0]!.html).toContain('<a href="https://example.test/right">Badge</a>)');
    expect(escapedBrackets[0]!.html).toContain('<a href="https://example.test/img?q=&amp;copy;">Build [linux]</a>');
    expect(escapedBrackets[0]!.html).toContain('<a href="https://example.test/ref?q=&amp;copy;&amp;x=&#X3B;">Build [linux]</a>');
    expect(escapedBrackets[0]!.html).toContain('<a href="https://example.test/right?q=&amp;copy;">Badge</a>');
  }

  // Code span inside image alt containing longer backtick runs and `](url)` keeps authored destination (#657).
  const trickyAlt = parseGramMessage("![``hello ``` tick ` ](https://example.test/wrong) end``](https://example.test/right)");
  expect(trickyAlt).toHaveLength(1);
  expect(trickyAlt[0]!.kind).toBe("markdown");
  if (trickyAlt[0]!.kind === "markdown") {
    expect(trickyAlt[0]!.html).toContain('href="https://example.test/right"');
    expect(trickyAlt[0]!.html).not.toContain('href="https://example.test/wrong"');
  }

  // Reference image preserves backslash-escaped ampersand and uppercase hex entity (#658).
  const refImg = parseGramMessage("![Badge][art]\n\n[art]: https://example.test/img?q=\\&copy;&x=&#X3B;");
  expect(refImg).toHaveLength(1);
  expect(refImg[0]!.kind).toBe("markdown");
  if (refImg[0]!.kind === "markdown") {
    expect(refImg[0]!.html).toContain('<a href="https://example.test/img?q=&amp;copy;&amp;x=&#X3B;">Badge</a>');
  }

  // Padded image destination with trailing parens preserves Markdown escapes (#669).
  const paddedImage = parseGramMessage("![Badge]( https://example.test/right?q=\\&copy;))");
  expect(paddedImage).toHaveLength(1);
  expect(paddedImage[0]!.kind).toBe("markdown");
  if (paddedImage[0]!.kind === "markdown") {
    expect(paddedImage[0]!.html).toContain('<a href="https://example.test/right?q=&amp;copy;">Badge</a>');
  }

  // Case-sensitive named entity scheme validation: lowercase `&colon;` stays openable while
  // browser-unrecognized `&COLON;`, escaped `\&colon;`, and `javascript&colon;` stay plain text.
  const entityScheme = parseGramMessage("![A](https&colon;//img.example.test/a) and ![B](https\\&colon;//img.example.test/b) and ![C](javascript&colon;alert(1)) and ![D](https&COLON;//img.example.test/d)");
  expect(entityScheme).toHaveLength(1);
  expect(entityScheme[0]!.kind).toBe("markdown");
  if (entityScheme[0]!.kind === "markdown") {
    expect(entityScheme[0]!.html).toContain('<a href="https&colon;//img.example.test/a">A</a>');
    expect(entityScheme[0]!.html).not.toContain('img.example.test/b');
    expect(entityScheme[0]!.html).not.toContain('javascript');
    expect(entityScheme[0]!.html).not.toContain('img.example.test/d');
    expect(entityScheme[0]!.html).toContain("and B and C and D");
  }

  // Relative image destinations render plain alt text instead of a dead link.
  const relImage = parseGramMessage("![Screenshot](docs/image.png)");
  expect(relImage).toHaveLength(1);
  expect(relImage[0]!.kind).toBe("markdown");
  if (relImage[0]!.kind === "markdown") {
    expect(relImage[0]!.html).not.toContain("<a ");
    expect(relImage[0]!.html).toContain("Screenshot");
  }

  // Linked image badge keeps the authored outer link destination and renders plain alt text inside it (#647).
  const badge = parseGramMessage("[![Build](https://ci.example.test/status.svg)](https://ci.example.test/builds/42)");
  expect(badge).toHaveLength(1);
  expect(badge[0]!.kind).toBe("markdown");
  if (badge[0]!.kind === "markdown") {
    expect(badge[0]!.html).toContain('<a href="https://ci.example.test/builds/42">Build</a>');
    expect(badge[0]!.html).not.toContain("status.svg");
  }

  // Raw HTML `<pre>` before a nested Markdown fence stays literal escaped text so it cannot
  // emit an extra DOM `<pre>` and shift `block.codes` onto the wrong block (#645).
  const rawPreBeforeFence = parseGramMessage("<pre><code>FIRST</code></pre>\n\n> ```sh\n> SECOND\n>\n> ```");
  expect(rawPreBeforeFence).toHaveLength(1);
  expect(rawPreBeforeFence[0]!.kind).toBe("markdown");
  if (rawPreBeforeFence[0]!.kind === "markdown") {
    expect(rawPreBeforeFence[0]!.html).toContain("<p>&lt;pre&gt;&lt;code&gt;FIRST&lt;/code&gt;&lt;/pre&gt;</p>");
    expect((rawPreBeforeFence[0]!.html.match(/<pre>/g) ?? []).length).toBe(1);
    expect(rawPreBeforeFence[0]!.codes).toEqual([{ code: "SECOND\n", language: "sh" }]);
  }
});
