import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const simplifiedSource = {
  build: "79979f1379",
  base: "6cfcd17746b5",
};

export function assembleOfficialLocales(source, out) {
  const desktop = path.join(source, "src/renderer/i18n");
  const online = path.join(source, "src/cloud/i18n");
  const target = path.join(out, "ui/i18n");
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  const evidence = [];
  const write = ({ name, part, catalog, onlineEnglish, provenance, raw }) => {
    const dest = path.join(target, part, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, raw ?? JSON.stringify(catalog) + "\n");
    evidence.push({
      locale: name.slice(0, -5),
      part: part || "base",
      ...provenance,
      translatedMessages: Object.keys(catalog).length,
      onlineMessages: Object.keys(onlineEnglish).length,
      unmatchedOnlineMessages: Object.keys(onlineEnglish).filter(
        (id) => !Object.hasOwn(catalog, id),
      ).length,
    });
  };
  for (const name of fs
    .readdirSync(desktop)
    .filter((name) => name.endsWith(".json") && name !== "en-US.json")) {
    for (const part of ["", "dynamic"]) {
      const src = path.join(desktop, part, name);
      const raw = fs.readFileSync(src);
      const desktopEnglish = read(path.join(desktop, part, "en-US.json"));
      const onlineEnglish = read(path.join(online, part, "en-US.json"));
      write({
        name,
        part,
        catalog: Object.fromEntries(
          Object.entries(JSON.parse(raw)).filter(
            ([id, translation]) =>
              typeof translation === "string" &&
              Object.hasOwn(onlineEnglish, id) &&
              onlineEnglish[id] === desktopEnglish[id],
          ),
        ),
        onlineEnglish,
        provenance: {
          sourceKind: "matched-desktop",
          source: path.relative(source, src),
          sha256: digest(raw),
        },
      });
    }
  }

  const html = fs.readFileSync(path.join(online, "../index.html"), "utf8");
  if (html.includes(`data-build-id="${simplifiedSource.build}"`)) {
    const versions = /[",]zh-Hans:[0-9a-f]{12}\.([0-9a-f]{12})[",]/.exec(html);
    if (!versions)
      throw Error(
        "The pinned renderer does not declare Simplified Chinese catalogs.",
      );
    for (const { part, cut, version, sourceKind } of [
      {
        part: "",
        cut: "s/",
        version: simplifiedSource.base,
        sourceKind: "matched-online",
      },
      {
        part: "dynamic",
        cut: "dynamic/",
        version: versions[1],
        sourceKind: "exact-online",
      },
    ]) {
      const file = `vendor/official-locales/${simplifiedSource.build}/zh-Hans.${version}.json`;
      const raw = fs.readFileSync(
        fileURLToPath(new URL(`../${file}`, import.meta.url)),
      );
      const sha256 = digest(raw);
      if (!sha256.startsWith(version))
        throw Error(`Official locale version mismatch: ${file}`);
      const original = JSON.parse(raw);
      const onlineEnglish = read(path.join(online, part, "en-US.json"));
      let catalog = original;
      if (!part) {
        const desktopEnglish = read(path.join(desktop, "en-US.json"));
        const aliases = new Map();
        for (const id of new Set([
          ...Object.keys(onlineEnglish),
          ...Object.keys(desktopEnglish),
        ])) {
          if (!/^[A-Za-z0-9+/]{10}$/.test(id)) continue;
          const alias = id.slice(0, 6);
          aliases.set(alias, aliases.has(alias) ? null : id);
        }
        catalog = Object.fromEntries(
          Object.entries(onlineEnglish).flatMap(([id, english]) => {
            if (english !== desktopEnglish[id]) return [];
            const alias = id.slice(0, 6);
            const translation =
              original[id] ??
              (aliases.get(alias) === id ? original[alias] : undefined);
            return typeof translation === "string" ? [[id, translation]] : [];
          }),
        );
      }
      write({
        name: "zh-Hans.json",
        part,
        catalog,
        onlineEnglish,
        provenance: {
          sourceKind,
          source: file,
          reference: `https://claude.ai/i18n/${cut}zh-Hans.json?v=${version}`,
          sha256,
        },
        raw: part ? raw : undefined,
      });
    }
  }
  fs.writeFileSync(
    path.join(out, "data/locale-recovery.json"),
    JSON.stringify(
      {
        source: "official online and bundled desktop catalogs",
        limit:
          "Matched catalogs reuse messages with identical English by ID. The renderer uses its English fallback for unmatched messages.",
        catalogs: evidence,
      },
      null,
      2,
    ) + "\n",
  );
  return evidence;
}
