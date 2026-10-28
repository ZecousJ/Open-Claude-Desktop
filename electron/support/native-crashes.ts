import fs from "node:fs";
import path from "node:path";

export interface NativeCrashReporter {
  start(options: {
    companyName: string;
    productName: string;
    submitURL: string;
    uploadToServer: boolean;
    compress: boolean;
    ignoreSystemCrashHandler: boolean;
    globalExtra: Record<string, string>;
  }): void;
  addExtraParameter(key: string, value: string): void;
}

// Local Crashpad capture. No dump is uploaded to a service.
export function startNativeCrashes(
  reporter: NativeCrashReporter,
  productName: string,
  version: string,
) {
  reporter.start({
    companyName: "",
    productName,
    submitURL: "https://f.a.k/e",
    uploadToServer: false,
    compress: true,
    ignoreSystemCrashHandler: true,
    globalExtra: { release: `${productName}@${version}` },
  });
}

export function recordGpuExit(
  reporter: Pick<NativeCrashReporter, "addExtraParameter">,
  details: { type: string; reason: string; exitCode: number },
  now = new Date(),
) {
  if (details.type !== "GPU" || details.reason === "clean-exit") return;
  const code = details.exitCode | 0;
  reporter.addExtraParameter("gpu_last_exit_code", String(code));
  reporter.addExtraParameter(
    "gpu_last_exit_code_hex",
    `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`,
  );
  reporter.addExtraParameter("gpu_last_exit_reason", details.reason);
  reporter.addExtraParameter("gpu_last_exit_at", now.toISOString());
}

export function keepCrashStack(directory: string, error: unknown) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "exceptions.log");
    if (fs.existsSync(file) && fs.statSync(file).size >= 2 * 1024 * 1024)
      fs.renameSync(file, path.join(directory, "exceptions.previous.log"));
    fs.appendFileSync(
      file,
      `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      { mode: 0o600 },
    );
  } catch {}
}
