import fs from "node:fs";
import path from "node:path";
import type { StealthWindow } from "./stealth";

const marker = (userData: string) =>
  path.join(userData, "stealth-relaunch.json");

export function saveStealthWindow(userData: string, state: StealthWindow) {
  fs.writeFileSync(
    marker(userData),
    JSON.stringify({ ...state, at: Date.now() }),
    { mode: 0o600 },
  );
}

export function takeStealthWindow(userData: string): StealthWindow | undefined {
  const file = marker(userData);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof value.visible === "boolean" &&
      typeof value.minimized === "boolean" &&
      typeof value.at === "number" &&
      Date.now() - value.at < 10 * 60_000
    )
      return { visible: value.visible, minimized: value.minimized };
  } catch {
    /* Ordinary launch. */
  } finally {
    fs.rmSync(file, { force: true });
  }
}
