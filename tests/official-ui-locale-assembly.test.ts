import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Build-time JavaScript helper.
import { assembleOfficialLocales } from "../scripts/official-ui-locales.mjs";

test("the pinned build ships official Simplified Chinese with English fallback for unmatched messages", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-locale-assembly-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const out = path.join(root, "out");
  const write = (file: string, text: string) => {
    const dest = path.join(source, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  };
  write(
    "src/cloud/index.html",
    '<html data-build-id="79979f1379"><meta data-i18n-catalogs="zh-Hans:94dddc304e2e.f054ba51edf0,zh-Hant:67d18abd3708.edd65346f3ad">',
  );
  const copyLabels = { "4l6vz1/eZ5": "Copy", "4l6vz1t2qY": "Copy" };
  write(
    "src/renderer/i18n/en-US.json",
    JSON.stringify({
      D3idYvSLF9: "Settings",
      ABAQyoD6zr: "Conversations",
      ...copyLabels,
    }),
  );
  write(
    "src/cloud/i18n/en-US.json",
    JSON.stringify({
      D3idYvSLF9: "Settings",
      ABAQyoD6zr: "Chats",
      S22rpStNvT: "New chat",
      ...copyLabels,
    }),
  );
  write(
    "src/cloud/i18n/dynamic/en-US.json",
    JSON.stringify({ "2EcGZn58SU": "Auto thinking" }),
  );
  fs.mkdirSync(path.join(out, "data"), { recursive: true });

  const catalogues: {
    locale: string;
    part: string;
    unmatchedOnlineMessages?: number;
  }[] = assembleOfficialLocales(source, out);
  const read = (part: string) =>
    JSON.parse(
      fs.readFileSync(path.join(out, "ui/i18n", part, "zh-Hans.json"), "utf8"),
    );
  assert.deepEqual(read(""), {
    D3idYvSLF9: "设置",
    "4l6vz1/eZ5": "复制",
    "4l6vz1t2qY": "复制",
  });
  assert.equal(read("dynamic")["2EcGZn58SU"], "自动思考");
  assert.equal(
    catalogues.find(
      ({ locale, part }) => locale === "zh-Hans" && part === "base",
    )?.unmatchedOnlineMessages,
    2,
  );
  assert.equal(fs.existsSync(path.join(out, "ui/i18n/zh-Hant.json")), false);
});
