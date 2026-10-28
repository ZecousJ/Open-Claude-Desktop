import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { redactSupportLog } from "./support-bundle";

let installed = false;

export function installSupportLogging(directory: string) {
  if (installed) return;
  installed = true;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "support.log");
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      original(...values);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size >= 2 * 1024 * 1024) {
          fs.renameSync(file, path.join(directory, "support.previous.log"));
        }
        const message = redactSupportLog(format(...values)).slice(0, 16_384);
        fs.appendFileSync(
          file,
          `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`,
          { mode: 0o600 },
        );
      } catch {}
    };
  }
}
