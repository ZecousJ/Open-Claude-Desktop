/**
 * Settings → General → Appearance → Transcript text size: the stored choice,
 * its validation, the Settings row, the data-text-size attribute on Code's
 * prompts, replies and queued messages, and the sizes the stylesheets give each
 * choice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Turn } from "../../shared/types";
import { preferenceDefaults } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import {
  messageTextSize,
  transcriptTextSize,
} from "../../src/transcript/transcript-text-size";
import { QueuedMessageBar } from "../../src/composer/QueuedMessageBar";
import { CodeUserMessage } from "../../src/transcript/CodeUserMessage";
import { TranscriptAppearance } from "../../src/settings/tabs/TranscriptAppearance";

const css = (file: string) =>
  fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");

test("the choice is Small, Medium or Large, Medium until chosen", () => {
  assert.equal(preferenceDefaults.transcriptTextSize, "m");
  assert.equal(transcriptTextSize(undefined), "m");
  assert.equal(transcriptTextSize({}), "m");
  assert.equal(transcriptTextSize({ transcriptTextSize: "s" }), "s");
  assert.equal(transcriptTextSize({ transcriptTextSize: "l" }), "l");
  // A value from elsewhere (an older or newer settings file) reads as Medium.
  assert.equal(transcriptTextSize({ transcriptTextSize: "xl" as any }), "m");
  const field = preferenceFields.transcriptTextSize;
  for (const size of ["s", "m", "l", undefined])
    assert.equal(field.safeParse(size).success, true, String(size));
  assert.equal(field.safeParse("xl").success, false);
  assert.equal(field.safeParse("large").success, false);
});

test("a message is marked sm or lg, and Medium leaves it unmarked", () => {
  assert.equal(messageTextSize("s"), "sm");
  assert.equal(messageTextSize("m"), undefined);
  assert.equal(messageTextSize("l"), "lg");
  assert.equal(messageTextSize(undefined), undefined);
});

test("Settings → General offers the three sizes, the current one checked", () => {
  const render = (transcriptTextSize?: "s" | "m" | "l") =>
    renderToStaticMarkup(
      createElement(TranscriptAppearance, {
        settings: {
          codeSandbox: "workspace-write",
          codeEffort: "high",
          codeFont: "",
          ...(transcriptTextSize ? { transcriptTextSize } : {}),
        },
        save: () => {},
        platform: "darwin",
        engine: { state: "ready" },
        onError: () => {},
        goTo: () => {},
      } as any),
    );
  const group = (html: string) =>
    html.match(
      /role="radiogroup" aria-label="Transcript text size"[^>]*>[\s\S]*?<\/div>/,
    )?.[0] ?? "";
  const medium = group(render());
  assert.ok(medium, "the row is drawn");
  assert.doesNotMatch(medium, /disabled/);
  assert.match(medium, /aria-checked="true"[^>]*>Medium</);
  assert.match(medium, /aria-checked="false"[^>]*>Small</);
  assert.match(group(render("l")), /aria-checked="true"[^>]*>Large</);
  assert.match(group(render("s")), /aria-checked="true"[^>]*>Small</);
});

test("a Code prompt and the queued messages carry the message size", () => {
  const turn = {
    id: "t",
    prompt: "Hello",
    createdAt: 0,
    items: [],
    status: "completed",
  } as unknown as Turn;
  assert.match(
    renderToStaticMarkup(
      createElement(CodeUserMessage, { turn, textSize: "lg" }),
    ),
    /class="user-message" data-text-size="lg"/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(CodeUserMessage, { turn })),
    /data-text-size/,
  );
  const entry = {
    id: "q",
    text: "Next",
    attachments: [],
    state: "queued" as const,
    mode: "code" as const,
    providerId: "p",
    model: "m",
    webSearch: false,
  };
  const bar = (textSize?: "sm" | "lg") =>
    renderToStaticMarkup(
      createElement(QueuedMessageBar, { entries: [entry as any], textSize }),
    );
  assert.match(bar("sm"), /class="queued-bar" data-text-size="sm"/);
  assert.doesNotMatch(bar(), /data-text-size/);
});

test("the stylesheets size each choice as the original does", () => {
  const sizes = css("transcript/transcript-text-size.css");
  const block = (selector: string) => {
    const at = sizes.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return sizes.slice(at, sizes.indexOf("}", at));
  };
  // The transcript's rows: --chat-body and --chat-leading.
  assert.match(block(":root"), /--transcript-text: 14px;/);
  assert.match(block(":root"), /--transcript-line: 20px;/);
  const small = block(':root[data-chat-text-size="s"]');
  assert.match(small, /--transcript-text: 13px;/);
  assert.match(small, /--transcript-line: calc\(13px \* 1\.42857\);/);
  assert.match(small, /--prompt-text: 13px;/);
  assert.match(small, /--document-body: 14px;/);
  const large = block(':root[data-chat-text-size="l"]');
  assert.match(large, /--transcript-text: 15px;/);
  assert.match(large, /--transcript-line: calc\(15px \* 1\.46667\);/);
  assert.match(large, /--prompt-text: 15px;/);
  assert.match(large, /--prompt-line: 21px;/);
  assert.match(large, /--document-body: 16px;/);
  // A message's body and prose.
  assert.match(
    block('[data-text-size="sm"]'),
    /--message-text: 13px;\s*--message-line: 19px;/,
  );
  assert.match(
    block('[data-text-size="lg"]'),
    /--message-text: 15px;\s*--message-line: 22px;/,
  );
  // The rules that read them, Medium's values as the fallback.
  const transcript = css("transcript/code-transcript.css");
  assert.match(
    transcript,
    /\.mode-code \.user-message \{\s*font-size: var\(--message-text, 14px\);\s*line-height: var\(--message-line, 20px\);/,
  );
  assert.match(
    transcript,
    /\.mode-code \.assistant-content > \.markdown p \{\s*font-size: var\(--message-text, 14px\);/,
  );
  assert.match(
    transcript,
    /\.mode-code \.code-command > summary \{[^}]*font-size: var\(--transcript-text, 14px\);\s*line-height: var\(--transcript-line, 20px\);/,
  );
  assert.match(
    css("styles/91-reference-workspace.css"),
    /\.code-composer \.composer-input-row textarea \{[^}]*font-size: var\(--prompt-text, 14px\);/,
  );
  assert.match(
    css("composer/queued-message-bar.css"),
    /\.queued-bar-band \{[^}]*font-size: var\(--message-text, 14px\);/,
  );
  assert.match(
    css("artifacts/file-viewer-panel.css"),
    /--markdown-document-measure: calc\(var\(--document-body, 15px\) \* 36\);/,
  );
});
