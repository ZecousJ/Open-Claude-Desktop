import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
const root = process.cwd(),
  out = path.join(root, "dist-mobile-conversation");
const sha = (b) => createHash("sha256").update(b).digest("hex");
// Paths in the checks and the manifest are written with "/" on every system.
const posix = (p) => p.split(path.sep).join("/");
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const sources = new Set();
const dependencies = new Map();
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")).packages;
for (const file of files(out).filter((f) => f.endsWith(".map")))
  for (const source of JSON.parse(readFileSync(file, "utf8")).sources) {
    const abs = path.resolve(path.dirname(file), source);
    const dependency = abs
      .replaceAll("\\", "/")
      .match(/(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    if (dependency && !dependencies.has(dependency[2])) {
      const installed = JSON.parse(
        readFileSync(path.join(dependency[1], "package.json"), "utf8"),
      );
      const expected = lock[`node_modules/${dependency[2]}`]?.version;
      assert.equal(
        installed.version,
        expected,
        `Bundled dependency differs from lock: ${dependency[2]}`,
      );
      dependencies.set(dependency[2], installed.version);
    }
    if (
      abs.startsWith(root + path.sep) &&
      !posix(abs).includes("/node_modules/")
    )
      // A module imported with a query (`?url`) is the file itself.
      sources.add(posix(path.relative(root, abs)).replace(/\?.*$/, ""));
  }
const required = [
  "src/transcript/ConversationTranscript.tsx",
  "src/transcript/ChatTurnContent.tsx",
  "src/transcript/ChatSteps.tsx",
  "src/transcript/UserMessage.tsx",
  "src/transcript/ReplyToolbar.tsx",
  "src/transcript/ReplyVersions.tsx",
  "src/ui/Markdown.tsx",
  "src/ui/MarkdownImage.tsx",
  "src/artifacts/ArtifactCard.tsx",
  "src/artifacts/GeneratedFileCard.tsx",
  "src/artifacts/GeneratedImageCard.tsx",
  "src/composer/Attachments.tsx",
  "src/citations/CitationChip.tsx",
  "src/transcript/useTranscriptScroll.ts",
];
for (const file of required)
  assert.ok(
    sources.has(file),
    `Shared component missing from actual bundle: ${file}`,
  );
const styles = new Set();
function css(file) {
  if (styles.has(file)) return;
  styles.add(file);
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/@import\s+["']([^"']+)["']/g)) {
    const target = posix(path.normalize(path.join(path.dirname(file), m[1])));
    if (existsSync(target)) css(target);
  }
}
css("src/mobile-conversation/styles.css");
css("src/mobile-conversation/layout.css");
for (const slot of readFileSync(
  "src/mobile-conversation/main.tsx",
  "utf8",
).matchAll(/import\s+["'](\.\.\/[^"']+\.slot)["']/g)) {
  const file = posix(
    path.normalize(path.join("src/mobile-conversation", slot[1] + ".ts")),
  );
  sources.add(file);
  for (const sheet of readFileSync(file, "utf8").matchAll(
    /import\s+["']([^"']+\.css)["']/g,
  ))
    css(posix(path.normalize(path.join(path.dirname(file), sheet[1]))));
}
for (const required of [
  "src/artifacts/sheet-card.css",
  "src/live-web/transcript.css",
  "src/light-main/light-main.css",
])
  assert.ok(
    styles.has(required),
    `Missing late shared style layer: ${required}`,
  );
const html = readFileSync(path.join(out, "index.html"), "utf8");
for (const rule of [
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
])
  assert.ok(html.includes(rule), `Missing CSP ${rule}`);
assert.doesNotMatch(html, /(?:src|href)=["']https?:/i);
const manifest = {
  version: 1,
  protocol: 1,
  entry: "index.html",
  sourceRevision: process.env.CLAUDEX_SOURCE_REVISION ?? "local-candidate",
  packageLockSha256: sha(readFileSync("package-lock.json")),
  bundledDependencies: Object.fromEntries([...dependencies].sort()),
  sharedComponents: required,
  sources: [...sources, ...styles]
    .sort()
    .map((file) => ({ file, sha256: sha(readFileSync(file)) })),
  assets: files(out)
    .filter((f) => !f.endsWith(".map") && !f.endsWith("reuse-manifest.json"))
    .sort()
    .map((file) => ({
      file: posix(path.relative(out, file)),
      bytes: readFileSync(file).length,
      sha256: sha(readFileSync(file)),
    })),
};
writeFileSync(
  path.join(out, "reuse-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Verified ${required.length} original shared components, ${sources.size} source modules and ${styles.size} shared stylesheet imports; manifest written.`,
);

// Source maps prove actual imports above, but do not ship inside native apps.
for (const file of files(out).filter((f) => f.endsWith(".map"))) rmSync(file);
