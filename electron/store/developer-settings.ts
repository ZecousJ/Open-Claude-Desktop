import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface DeveloperSettings {
  allowDevTools?: boolean;
  [key: string]: unknown;
}

export function readDeveloperSettings(file: string): DeveloperSettings {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const settings = JSON.parse(text);
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    (settings.allowDevTools !== undefined &&
      typeof settings.allowDevTools !== "boolean")
  )
    throw new Error("Invalid developer settings");
  return settings;
}

export function developerModeAllowed(policy: {
  developerModeEnabled?: boolean;
  pending?: boolean;
}) {
  return !policy.pending && policy.developerModeEnabled !== false;
}

export function developerToolsAllowed(
  file: string,
  policy: {
    developerModeEnabled?: boolean;
    pending?: boolean;
  },
) {
  if (!developerModeAllowed(policy)) return false;
  try {
    return readDeveloperSettings(file).allowDevTools === true;
  } catch {
    return false;
  }
}

export interface DeveloperModeDialog {
  type: "warning" | "error";
  title?: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

export async function enableDeveloperSettings(options: {
  file: string;
  allowed: () => boolean;
  translate: (text: string) => string;
  showMessageBox: (
    options: DeveloperModeDialog,
  ) => Promise<{ response: number }>;
  restart: () => void;
}) {
  if (!options.allowed()) return;
  const { translate } = options;
  const { response } = await options.showMessageBox({
    type: "warning",
    title: translate("Enable Developer Mode?"),
    message: translate(
      "Developer mode allows access to developer tools and debugging features. Only enable this if you know what you're doing.",
    ),
    buttons: [translate("Enable"), translate("Don't Enable")],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0 || !options.allowed()) return;
  const temporary = `${options.file}.${randomUUID()}.tmp`;
  try {
    const settings = {
      ...readDeveloperSettings(options.file),
      allowDevTools: true,
    };
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, options.file);
  } catch (error) {
    console.error("[help-menu] failed to write developer settings", error);
    await options.showMessageBox({
      type: "error",
      message: translate("Couldn't enable developer mode"),
      detail: translate(
        "Couldn't save developer settings. Check write access to Claudex's settings folder, then try again.",
      ),
    });
    return;
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
  options.restart();
}
