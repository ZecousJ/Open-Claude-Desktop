import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings } from "../../electron/store/store";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { chatFontLabels } from "../../src/settings/tabs/General";
import {
  previewDelayMs,
  previewSample,
} from "../../src/settings/voice-preview";
import { navGroups } from "../../src/settings/nav";

test("the Settings navigation has the original's four groups in order", () => {
  assert.deepEqual(
    navGroups.map((group) => group.label),
    ["Settings", "Customize", "This computer"],
  );
});

test("the new appearance settings take only their own values", () => {
  assert.equal(preferenceFields.transcriptWidth.safeParse("l").success, true);
  assert.equal(
    preferenceFields.interfaceFont.safeParse("dyslexic").success,
    true,
  );
  assert.equal(
    preferenceFields.interfaceFont.safeParse("comic").success,
    false,
  );
});

test("Transcript width is Narrow and the interface font Claudex Sans by default", () => {
  assert.equal(preference(defaultSettings, "transcriptWidth"), "s");
  assert.equal(preference(defaultSettings, "interfaceFont"), "anthropic");
});

test("a Style preview waits 150ms and speaks in the voice's language", () => {
  assert.equal(previewDelayMs, 150);
  assert.equal(previewSample("de-DE"), "Hallo, so klinge ich.");
  assert.equal(previewSample("en-GB"), "Hi, this is how I sound.");
  // A language without its own line falls back to English.
  assert.equal(previewSample("sv-SE"), "Hi, this is how I sound.");
});
