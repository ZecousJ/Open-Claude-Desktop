import ts from "typescript";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  checklistRows,
  checklistShowing,
  type HomeStarters,
} from "../../shared/home-starters";
import { preferenceFields } from "../../shared/settings-extras-schema";
import {
  desktopPreferenceFields,
  publicPreferences,
  withoutPreferences,
} from "../../electron/store/settings-preferences";
import { starterPromptsVisible } from "../../src/starter-prompts/visibility";
import { voicePlaceholder } from "../../src/composer/voice-placeholder";
import { isVoiceConnectionError } from "../../src/voice/connection-error";
import { SubmitPill } from "../../src/composer/SubmitPill";
import { AppIcon } from "../../src/ui/app-icon";
import type { CustomizeSkill } from "../../shared/collections-api";
import { readSource } from "../support/read-source";

test("disabled home Send swaps the fill and glyph without dimming", () => {
  const css = readFileSync(
    new URL("../../src/composer/composer-core.css", import.meta.url),
    "utf8",
  );
  const disabled = css.match(
    /\.composer-submit-pill \.send-button:disabled\s*\{([^}]+)\}/,
  )?.[1];
  assert.ok(disabled);
  assert.match(disabled, /background:\s*rgb\(255 255 255 \/ 10%\)/);
  assert.match(disabled, /color:\s*#898781/);
  assert.match(disabled, /cursor:\s*not-allowed/);
  assert.match(disabled, /opacity:\s*1;/);
  assert.match(
    css,
    /:root\[data-theme="light"\] \.composer-submit-pill \.send-button:disabled\s*\{\s*background:\s*rgb\(11 11 11 \/ 10%\)/,
  );
});

test("starter chips fail open with no experiments and respect competing surfaces", () => {
  assert.equal(starterPromptsVisible({}), true);
  for (const state of [
    { incognito: true },
    { voiceActive: true },
    { hideStarterChips: true },
    { override: "hide" as const },
    { conversationCount: 25 },
    { conversationLoading: true },
    { checklistLoading: true },
    { checklistShowing: true, hideForChecklist: true },
  ])
    assert.equal(starterPromptsVisible(state), false, JSON.stringify(state));
  assert.equal(starterPromptsVisible({ checklistShowing: true }), true);
  assert.equal(starterPromptsVisible({ conversationCount: 24 }), true);
  assert.equal(
    starterPromptsVisible({
      override: "show",
      conversationCount: 25,
      conversationLoading: true,
    }),
    true,
  );
});

test("checklist preferences persist partial task state and stop showing after three impressions", () => {
  const config: HomeStarters = {
    prosumer_checklist_hide_prompt_chips: true,
    prosumer_checklist_v2: {
      setup_project: true,
      explore_skills: true,
      connect_tools: true,
    },
    checklist: {
      tasks: {
        setup_project: { clicked: true },
        connect_tools: { dismissed: true },
      },
    },
  };
  assert.equal(preferenceFields.homeStarters.safeParse(config).success, true);
  assert.deepEqual(checklistRows(config), ["explore_skills", "setup_project"]);
  assert.equal(checklistShowing(config), true);
  config.checklist!.tasks!.explore_skills = { seen: 3 };
  assert.equal(checklistShowing(config), false);
  config.checklist!.tasks!.explore_skills = { seen: 1, clicked: true };
  assert.equal(checklistShowing(config), false);
  assert.equal(
    checklistShowing({ ...config, checklist: { dismissed: true } }),
    false,
  );
  assert.equal(
    preferenceFields.homeStarters.safeParse({
      checklist: { tasks: { setup_project: { seen: -1 } } },
    }).success,
    false,
  );
});

test("desktop and web preference schemas retain starter gates and checklist progress", () => {
  const homeStarters: HomeStarters = {
    chipsOverride: "show",
    prosumer_checklist_hide_prompt_chips: true,
    prosumer_checklist_v2: { setup_project: true },
    checklist: { tasks: { setup_project: { seen: 2, clicked: true } } },
  };
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const saved = desktopPreferenceFields(platform).homeStarters.parse(
      JSON.parse(JSON.stringify(homeStarters)),
    );
    assert.deepEqual(publicPreferences({ homeStarters: saved }), {
      homeStarters,
    });
    assert.deepEqual(
      withoutPreferences({ homeStarters: saved, model: "test" }),
      {
        model: "test",
      },
    );
  }
});

test("voice placeholders reflect the owning phase, with dictation taking priority", () => {
  for (const [phase, expected] of [
    ["off", undefined],
    ["starting", "Connecting..."],
    ["listening", "Listening..."],
    ["thinking", "Processing..."],
    ["speaking", "Claudex is speaking..."],
    ["reconnecting", "Reconnecting..."],
  ] as const)
    assert.equal(voicePlaceholder("idle", phase), expected);
  assert.equal(voicePlaceholder("requesting", "speaking"), "Connecting...");
  assert.equal(voicePlaceholder("recording", "thinking"), "Listening...");
  assert.equal(voicePlaceholder("finishing", "off"), undefined);
  assert.equal(isVoiceConnectionError(new Error("Failed to fetch")), true);
  assert.equal(isVoiceConnectionError(new Error("HTTP 503")), true);
  assert.equal(
    isVoiceConnectionError(new Error("Permission denied: network")),
    false,
  );
  assert.equal(isVoiceConnectionError(new Error("HTTP 401")), false);
});

test("Stop and Send share a 68px capsule only when a running turn has content", () => {
  const render = (running: boolean, hasContent: boolean) =>
    renderToStaticMarkup(
      createElement(SubmitPill, {
        running,
        hasContent,
        stop: createElement("button", {
          "aria-label": "Stop response",
          children: null,
        }),
        send: createElement("button", { "aria-label": "Send message" }),
      }),
    );
  const idle = render(false, false);
  assert.match(idle, /width:32px/);
  assert.doesNotMatch(idle, /Stop response|<svg/);
  const stop = render(true, false);
  assert.match(stop, /width:32px/);
  assert.match(stop, /r="15.25" pathLength="12"/);
  assert.doesNotMatch(stop, /Send message/);
  const grouped = render(true, true);
  assert.match(grouped, /width:68px;gap:4px/);
  assert.match(grouped, /pathLength="20"/);
  assert.ok(grouped.indexOf("Stop response") < grouped.indexOf("Send message"));
  assert.doesNotMatch(grouped, /<circle/);
});

test("reply controls stay ghost for empty, drafting, disabled and streaming states", () => {
  for (const running of [false, true]) {
    for (const hasContent of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(SubmitPill, {
          reply: true,
          running,
          hasContent,
          stop: createElement("button", {
            className: "send-button stop plain",
            "aria-label": "Stop response",
            children: createElement(AppIcon, {
              name: "StopCircle",
              size: 20,
            }),
          }),
          send: createElement("button", {
            className: "send-button plain",
            "aria-label": "Send message",
            disabled: !hasContent,
            children: createElement(AppIcon, {
              name: "ArrowReturn",
              size: 20,
            }),
          }),
        }),
      );
      assert.match(html, /composer-reply-submit/);
      assert.doesNotMatch(
        html,
        /composer-submit-pill|composer-capsule-ring|pathLength/,
      );
      assert.equal(html.includes("StopCircle"), running);
      assert.equal(html.includes("ArrowReturn"), !running || hasContent);
      assert.equal(html.includes('disabled=""'), !running && !hasContent);
      assert.equal(
        (html.match(/<button/g) ?? []).length,
        running && hasContent ? 2 : 1,
      );
    }
  }
});

test("Chat and Cowork wire reply icons and preserve a separate chin voice action", () => {
  const source = readSource("src/composer/Composer.tsx");
  assert.match(source, /plainGlyphs = mode !== "code" && Boolean\(active\)/);
  assert.match(
    source,
    /name=\{plainGlyphs \? "ArrowReturn" : "ComposerSend"\}/,
  );
  assert.match(source, /name=\{plainGlyphs \? "StopCircle" : "Stop"\}/);
  assert.match(source, /reply=\{plainGlyphs\}/);
  const chin = source.slice(
    source.indexOf("const chinVoice"),
    source.indexOf("const ring ="),
  );
  // Current web replies put the device disclosure in the 41px voice group;
  // the legacy dictation split keeps its own disclosure.
  assert.match(chin, /options=\{!webReplyVoice\}\s+optionsReason/);
  // Current main Chat, including incognito, retains voice. Independent
  // embedded/task projections still use the production privacy gate.
  assert.match(chin, /mode !== "code" && incognitoControls/);
  assert.match(source, /const incognitoControls\s*=\s*!incognito\s*\|\|\s*\(/);
  assert.match(source, /appContext\.windowRole\.kind === "main"/);
  assert.match(source, /!\("ClaudexConversation" in window\)/);
  assert.match(chin, /waveform\s/);
  // The web reply chin: Dictate, then voice mode as the reply split button
  // whose caret opens the microphone options.
  const reply = chin.slice(
    chin.indexOf("webReplyVoice ? ("),
    chin.indexOf(") : (", chin.indexOf("webReplyVoice ? (")),
  );
  assert.match(reply, /\{micButton\}/);
  assert.match(reply, /<VoiceModeButton\s+variant="reply"/);
  assert.match(reply, /iconSize=\{16\}/);
  assert.doesNotMatch(reply, /microphoneOptions=\{false\}/);
  assert.doesNotMatch(chin, /!hasDraft/);
  const css = readFileSync("src/composer/composer-core.css", "utf8");
  assert.match(
    css,
    /\.send-button\.plain:disabled\s*\{\s*background: transparent;\s*opacity: var\(--opacity-disabled\);\s*pointer-events: none;/,
  );
  assert.match(
    css,
    /\.send-button\.plain:hover:not\(:disabled\)\s*\{\s*background: var\(--fill-ghost-hover\)/,
  );
  assert.match(css, /\.composer-reply-submit\s*\{[^}]*gap: 8px;/);
});

test("Add keeps the official long accessible label; Stop is ghost without an invented tooltip", () => {
  const source = readSource("src/composer/Composer.tsx");
  assert.match(
    source,
    /label=\{mode === "code" \? "Add" : "Add files, connectors, and more"\}/,
  );
  assert.match(source, /AppIcon name="ComposerAdd"/);
  const stop = source.slice(
    source.indexOf("const chatStopFace"),
    source.indexOf("const stopSlot"),
  );
  assert.match(stop, /composer-ghost-stop/);
  assert.doesNotMatch(stop, /Stop Claudex's response/);
});
