import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadSkillPage } from "../../src/collections/customize/UploadSkillPage";

test("the single-file skill upload view keeps singular official copy without assuming a host scan capability", () => {
  const html = renderToStaticMarkup(
    createElement(UploadSkillPage, { onBack() {}, onUploaded() {} }),
  );
  assert.match(html, /Upload a skill/);
  assert.match(html, /Add a skill to your workspace\./);
  // SSR has not read a host capability; the mounted capability branches are
  // exercised in customize-b32-skills-ui rather than promising a scanner.
  assert.doesNotMatch(html, /Runs when you upload/);
  assert.doesNotMatch(html, /Not available in Claudex/);
  assert.match(html, /multiple=""/);
});
