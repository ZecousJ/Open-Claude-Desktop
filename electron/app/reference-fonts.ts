import fs from "node:fs";
import path from "node:path";

/** Read display fonts from an existing local Claude installation; never bundle or persist them. */
export function referenceFonts() {
  const roots: string[] = [];
  if (process.platform === "darwin") {
    roots.push(
      "/Applications/Claude.app/Contents/Resources",
      path.join(
        process.env.HOME ?? "",
        "Applications/Claude.app/Contents/Resources",
      ),
    );
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    const program = process.env.ProgramFiles;
    if (program) roots.push(path.join(program, "Claude", "resources"));
    if (local)
      for (const base of [
        path.join(local, "AnthropicClaude"),
        path.join(local, "Claude"),
        path.join(local, "Programs", "Claude"),
      ]) {
        roots.push(path.join(base, "resources"));
        try {
          for (const entry of fs.readdirSync(base, { withFileTypes: true }))
            if (entry.isDirectory() && /^app-[\d.]+$/.test(entry.name))
              roots.push(path.join(base, entry.name, "resources"));
        } catch {
          /* Claude need not be installed. */
        }
      }
  }
  for (const root of roots) {
    const directory = path.join(root, "fonts");
    try {
      const names = fs.readdirSync(directory);
      const fonts: {
        family: string;
        style: "normal" | "italic";
        data: Uint8Array;
      }[] = [];
      for (const family of ["Sans", "Serif"])
        for (const [variant, style] of [
          ["Romans", "normal"],
          ["Italics", "italic"],
        ] as const) {
          const name = names.find((name) =>
            new RegExp(
              `^Anthropic${family}-${variant}-Variable-[a-zA-Z0-9]+\\.ttf$`,
            ).test(name),
          );
          if (!name) continue;
          const file = path.join(directory, name);
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.size > 5_000_000) continue;
          fonts.push({
            family: `Claudex Reference ${family}`,
            style,
            data: new Uint8Array(fs.readFileSync(file)),
          });
        }
      if (fonts.length) return fonts;
    } catch {
      /* Use the bundled system-font fallback if the installation is unavailable. */
    }
  }
  return [];
}
