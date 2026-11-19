import { execFile } from "node:child_process";
import path from "node:path";
import { app } from "electron";

export class DeviceKeyUnavailable extends Error {
  constructor(readonly reason: "linux" | "native_missing" | "no_tpm" | "key_state_unreadable") {
    super(reason);
  }
}

export function runDeviceKey(operation: "public" | "rotate" | "sign", directory: string, preimage?: Buffer): Promise<string> {
  const root = app.getAppPath();
  const file = path.join(directory, "device-signing-key");
  let executable: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      executable = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked", "dist-electron", "device-key-mac")
        : path.join(root, "dist-electron", "device-key-mac");
      args = [operation, file];
      break;
    case "win32":
      executable = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        app.isPackaged
          ? path.join(process.resourcesPath, "device-key-win.ps1")
          : path.join(root, "electron", "official-ui", "native", "device-key-win.ps1"),
        operation, file];
      break;
    default:
      return Promise.reject(new DeviceKeyUnavailable("linux"));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { timeout: 15_000, windowsHide: true, maxBuffer: 8192 }, (error, stdout) => {
      if (error) {
        reject(new DeviceKeyUnavailable(
          error.code === 2 ? "no_tpm" : error.code === "ENOENT" ? "native_missing" : "key_state_unreadable",
        ));
        return;
      }
      const value = stdout.trim();
      const bytes = Buffer.from(value, "base64");
      if (bytes.toString("base64") !== value || bytes.length !== (operation === "sign" ? 64 : 91)) {
        reject(new DeviceKeyUnavailable("key_state_unreadable"));
        return;
      }
      resolve(value);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(preimage?.toString("base64"));
  });
}
