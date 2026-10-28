import test from "node:test";
import assert from "node:assert/strict";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { ConversationDisclaimer } from "../../src/composer/ConversationDisclaimer";
import { readSource } from "../support/read-source";

const paths = [
  "styles/20-workspace.css",
  "transcript/chat-transcript.css",
  "live-web/composer.css",
  "styles/95-web.css",
];
const sheets = paths.map((path) =>
  readSource(new URL(`../../src/${path}`, import.meta.url), "utf8"),
);
// Count Selectors Level 4 specificity, including the max branch of :is/:not/:has.
function specificity(selector: string): number {
  let score = 0;
  for (let index = 0; index < selector.length;) {
    const char = selector[index];
    if (char === "[") {
      const end = selector.indexOf("]", index);
      score += 100;
      index = end + 1;
      continue;
    }
    if (char === "." || char === "#") {
      score += char === "." ? 100 : 10000;
      index++;
      const name = selector.slice(index).match(/^[\w-]+/);
      index += name?.[0].length ?? 0;
      continue;
    }
    if (char === ":") {
      index++;
      if (selector[index] === ":") {
        score++;
        index++;
      } else {
        const name = selector.slice(index).match(/^[\w-]+/)?.[0] ?? "";
        index += name.length;
        if (selector[index] === "(") {
          const start = ++index;
          let depth = 1;
          while (index < selector.length && depth) {
            if (selector[index] === "(") depth++;
            if (selector[index] === ")") depth--;
            index++;
          }
          if (["is", "not", "has"].includes(name))
            score += Math.max(
              ...postcss.list
                .comma(selector.slice(start, index - 1))
                .map(specificity),
            );
          else if (name !== "where") score += 100;
        } else score += 100;
        continue;
      }
    }
    const type = selector.slice(index).match(/^[a-zA-Z][\w-]*/);
    if (type) {
      score++;
      index += type[0].length;
    } else index++;
  }
  return score;
}
const parsed = new Map<string, postcss.Root>();
function style(element: Element, sources: string[], width: number) {
  const winners = new Map<string, { value: string; priority: number }>();
  for (const source of sources) {
    const root = parsed.get(source) ?? postcss.parse(source);
    parsed.set(source, root);
    root.walkRules((rule) => {
      let active = true;
      for (
        let parent:
          | postcss.AtRule
          | postcss.Rule
          | postcss.Root
          | postcss.Document
          | undefined = rule.parent;
        parent;
        parent = parent.parent
      ) {
        if (parent.type !== "atrule") continue;
        if (parent.name === "container" || /keyframes/.test(parent.name)) {
          active = false;
          break;
        }
        if (parent.name === "media") {
          const max = parent.params.match(/max-width:\s*([\d.]+)px/),
            min = parent.params.match(/min-width:\s*([\d.]+)px/);
          if (
            (max && width > +max[1]) ||
            (min && width < +min[1]) ||
            /pointer: coarse|hover: none/.test(parent.params)
          )
            active = false;
        }
      }
      if (!active) return;
      for (const selector of postcss.list.comma(rule.selector)) {
        let matches = false;
        try {
          matches = !selector.includes("::") && element.matches(selector);
        } catch {}
        if (!matches) continue;
        const weight = specificity(selector);
        rule.walkDecls((decl) => {
          const priority = weight + (decl.important ? 1000000 : 0);
          if ((winners.get(decl.prop)?.priority ?? -1) <= priority)
            winners.set(decl.prop, { value: decl.value, priority });
        });
      }
    });
  }
  return Object.fromEntries(
    [...winners].map(([key, value]) => [key, value.value]),
  );
}
function fixture(classes = "app web", code = false) {
  const note = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(ConversationDisclaimer),
    ),
  );
  return parseHTML(
    `<html data-surface="web"><body><div class="${classes}"><main class="has-conversation"><div id="wrap" class="composer-wrap conversation-composer ${code ? "code-composer" : "chat-composer"}"><div id="notice" class="composer-notice">Notice</div><div id="composer" class="composer"><div class="attachments"><span class="attachment-chip">File</span></div><div class="composer-input-row"><textarea></textarea></div></div><div id="chin" class="composer-chin conversation-footer"><div class="composer-dictation-target" id="dictation"></div><div id="leading" class="composer-chin-leading"><div id="anchor" class="popover-anchor"><button>Add</button></div><span class="chip">Attached context</span></div>${note}<div id="trailing" class="composer-chin-trailing"><div class="popover-anchor"><button>Model</button></div></div></div></div></main></div></body></html>`,
  ).document;
}
function contract(sources: string[]) {
  const document = fixture();
  const note = document.querySelector(".conversation-disclaimer")!;
  const find = (id: string) =>
    style(document.getElementById(id)!, sources, 390);
  const noteStyle = style(note, sources, 390);
  assert.equal(
    noteStyle.display,
    "block",
    "phone note stays visible over legacy display:none",
  );
  assert.equal(
    noteStyle["font-size"],
    "13px",
    "phone note must win over the old 11px web rule",
  );
  assert.equal(noteStyle["line-height"], "17px");
  assert.equal(noteStyle.order, "0");
  assert.equal(noteStyle.margin, "0 0 6px");
  assert.equal(
    find("chin").display,
    "contents",
    "one note flows before the input, not inside a chin box",
  );
  assert.equal(find("wrap").display, "grid");
  assert.equal(find("wrap").width, "calc(100% - 16px)");
  assert.equal(find("wrap").padding, "0 8px env(safe-area-inset-bottom)");
  assert.equal(
    find("wrap").height,
    undefined,
    "draft/chips can grow; wrapper height is not fixed",
  );
  assert.equal(find("composer").order, "1");
  assert.equal(find("notice").order, "-1");
  assert.equal(find("notice")["grid-column"], "1 / -1");
  assert.equal(find("leading").order, "2");
  assert.equal(find("leading").margin, "8px 0");
  assert.equal(find("leading")["min-height"], "24px");
  assert.equal(find("leading")["flex-wrap"], "wrap");
  assert.equal(find("trailing")["grid-column"], "2");
  assert.equal(find("anchor").display, "flex");
  assert.equal(find("dictation").display, "none");
  assert.equal(document.querySelectorAll(".conversation-disclaimer").length, 1);
  assert.equal(note.getAttribute("role"), "note");
  assert.equal(note.getAttribute("data-disclaimer"), "true");
}

test("phone conversation note wins the real CSS cascade in either lazy-sheet order", () => {
  contract(sheets);
  contract([sheets[0], sheets[1], sheets[3], sheets[2]]);
});
test("removing the phone layout restores the old hidden defect and is rejected", () => {
  const live = postcss.parse(sheets[2]);
  live.walkAtRules("media", (media) => {
    let contents = false;
    media.walkDecls("display", (decl) => {
      if (decl.value === "contents") contents = true;
    });
    if (contents) media.remove();
  });
  assert.throws(
    () => contract([sheets[0], sheets[1], live.toString(), sheets[3]]),
    /phone note stays visible/,
  );
});
test("desktop, native-wrapper and Code styles retain their previous layout; dictation still owns its row", () => {
  const base = postcss.parse(sheets[2]);
  base.walkAtRules("media", (media) => {
    let found = false;
    media.walkDecls("display", (decl) => {
      if (decl.value === "contents") found = true;
    });
    if (found) media.remove();
  });
  const before = [sheets[0], sheets[1], base.toString(), sheets[3]];
  for (const [classes, width, code] of [
    ["app web", 1440, false],
    ["app web mobile-conversation", 390, false],
    ["app", 390, false],
    ["app web", 390, true],
  ] as const) {
    const doc = fixture(classes, code);
    for (const selector of ["#wrap", "#chin", ".conversation-disclaimer"])
      assert.deepEqual(
        style(doc.querySelector(selector)!, sheets, width),
        style(doc.querySelector(selector)!, before, width),
        `${classes}/${width}/${code}`,
      );
  }
  const doc = fixture();
  doc.getElementById("chin")!.setAttribute("data-dictating", "true");
  assert.equal(
    style(doc.querySelector(".conversation-disclaimer")!, sheets, 390).display,
    "none",
  );
  assert.equal(
    style(doc.getElementById("dictation")!, sheets, 390).display,
    "flex",
  );
});

// The dock is frame + chin + bottom space; the outer wrapper additionally
// has 12px headroom. Expand padding before applying the same real-selector
// cascade above, so a legacy shorthand cannot hide a later edge override.
function dockSheets(previousBottom = false) {
  return [
    "styles/20-workspace.css",
    "styles/92-reference-pages.css",
    "styles/93-reference-responsive.css",
    "transcript/chat-transcript.css",
    "composer/code/code-composer-footer.css",
    "styles/95-web.css",
    "styles/chat-phone-parity.css",
    "composer/composer-core.css",
    "live-web/composer.css",
  ].map((path) => {
    const root = postcss.parse(
      readSource(new URL(`../../src/${path}`, import.meta.url), "utf8"),
    );
    if (previousBottom && path === "transcript/chat-transcript.css")
      root.walkRules((rule) => {
        if (
          rule.selector ===
          ":is(.mode-chat, .mode-cowork) .has-conversation .chat-composer"
        )
          rule.walkDecls("padding", (decl) => {
            decl.value = "12px 0 6px";
          });
      });
    root.walkDecls("padding", (decl) => {
      const values = postcss.list.space(decl.value),
        [top, right = top, bottom = top, left = right] = values;
      for (const [edge, value] of Object.entries({ top, right, bottom, left }))
        decl.cloneBefore({ prop: `padding-${edge}`, value });
      decl.remove();
    });
    return root.toString();
  });
}

test("desktop Chat/Cowork dock has an 8px bottom while retaining 12px wrapper headroom", () => {
  const sources = dockSheets();
  for (const surface of ["web", "desktop"] as const)
    for (const mode of ["chat", "cowork"] as const) {
      const document = fixture(`app ${surface} mode-${mode}`);
      document.documentElement.dataset.surface = surface;
      document.getElementById("notice")!.remove();
      document.querySelector(".attachments")!.remove();
      const find = (selector: string) =>
        style(document.querySelector(selector)!, sources, 1440);
      const wrapper = find("#wrap"),
        frame = find("#composer"),
        row = find(".composer-input-row"),
        chin = find("#chin"),
        textarea = find("textarea");
      assert.equal(wrapper["padding-top"], "12px");
      assert.equal(wrapper["padding-bottom"], "8px");
      assert.equal(
        wrapper.height,
        undefined,
        "do not freeze a growing wrapper at 88px",
      );
      assert.equal(frame["padding-top"], "8px");
      assert.equal(frame["padding-bottom"], "8px");
      assert.equal(chin["margin-top"], "8px");
      assert.equal(chin["min-height"], "24px");
      const px = (value: string) => parseFloat(value);
      const frameHeight = Math.max(
        px(frame["min-height"]),
        px(row["min-height"]) +
          px(frame["padding-top"]) +
          px(frame["padding-bottom"]),
      );
      const dockHeight =
        frameHeight +
        px(chin["margin-top"]) +
        px(chin["min-height"]) +
        px(wrapper["padding-bottom"]);
      const wrapperHeight = px(wrapper["padding-top"]) + dockHeight;
      // Calculated from the cascade, not browser getBoundingClientRect or
      // native paint proof. Root checks these rectangles in the real page.
      assert.equal(frameHeight, 48);
      assert.equal(dockHeight, 88);
      assert.equal(wrapperHeight, 100);
      const fieldTop = 900 - wrapperHeight + px(wrapper["padding-top"]);
      assert.equal(fieldTop, 812);
      assert.equal(fieldTop + frameHeight + px(chin["margin-top"]), 868);
      assert.equal(
        fieldTop + px(frame["padding-top"]) + px(textarea["padding-top"]),
        825.5,
      );
    }
});

test("dock edge correction rejects the old 6px value and leaves Code/home/phone cascades intact", () => {
  const before = dockSheets(true),
    after = dockSheets();
  for (const surface of ["web", "desktop"] as const) {
    const chat = fixture(`app ${surface} mode-chat`);
    chat.documentElement.dataset.surface = surface;
    assert.equal(
      style(chat.getElementById("wrap")!, before, 1440)["padding-bottom"],
      "6px",
    );
    assert.equal(
      style(chat.getElementById("wrap")!, after, 1440)["padding-bottom"],
      "8px",
    );
    const code = fixture(`app ${surface} mode-code`, true);
    code.documentElement.dataset.surface = surface;
    assert.deepEqual(
      style(code.getElementById("wrap")!, after, 1440),
      style(code.getElementById("wrap")!, before, 1440),
    );
    chat.querySelector(".has-conversation")!.className = "empty-chat";
    assert.deepEqual(
      style(chat.getElementById("wrap")!, after, 1440),
      style(chat.getElementById("wrap")!, before, 1440),
    );
  }
  const phone = fixture("app web mode-chat");
  assert.deepEqual(
    style(phone.getElementById("wrap")!, after, 390),
    style(phone.getElementById("wrap")!, before, 390),
  );
});
