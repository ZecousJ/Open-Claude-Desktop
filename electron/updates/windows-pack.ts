import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { appPackKeptFolder } from "./app-pack";
import { windowsAsarVersionReader, windowsPowerShellCommand } from "./scripts";

const prefix = ".claudex-update-";
const preparedName = /^\.claudex-update-[A-Za-z0-9]{6}$/;
const exec = promisify(execFile);

async function extractPack(
  file: string,
  destination: string,
): Promise<unknown> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    windowsAsarVersionReader,
    "Expand-Archive -LiteralPath $env:CLAUDEX_UPDATE_ZIP -DestinationPath $env:CLAUDEX_UPDATE_DESTINATION -Force",
    "Read-PackVersion $env:CLAUDEX_UPDATE_DESTINATION",
  ].join("\n");
  const command = windowsPowerShellCommand(
    ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    process.env.SystemRoot,
  );
  try {
    const { stdout } = await exec(command.command, command.args, {
      env: {
        ...process.env,
        CLAUDEX_UPDATE_ZIP: file,
        CLAUDEX_UPDATE_DESTINATION: destination,
      },
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error("The Windows app pack couldn't be unpacked.", {
      cause: error,
    });
  }
}

export async function prepareWindowsAppPack(
  {
    file,
    version,
    installDir,
  }: { file: string; version: string; installDir: string },
  extract = extractPack,
) {
  const prepared = await fs.promises.mkdtemp(path.join(installDir, prefix));
  try {
    if ((await extract(file, prepared)) !== version)
      throw new Error(
        "The app pack doesn't contain the expected Claudex version.",
      );
    if (fs.existsSync(path.join(prepared, appPackKeptFolder)))
      throw new Error(
        "The app pack contains the Codex folder it should preserve.",
      );
    return prepared;
  } catch (error) {
    await fs.promises
      .rm(prepared, { recursive: true, force: true })
      .catch(() => {});
    throw error;
  }
}

function isPreparedPath(installDir: string, prepared: string) {
  return (
    path.relative(installDir, path.dirname(prepared)) === "" &&
    preparedName.test(path.basename(prepared))
  );
}

export function preparedWindowsAppPack(installDir: string, prepared: string) {
  return (
    isPreparedPath(installDir, prepared) &&
    fs.existsSync(path.join(prepared, "app.asar"))
  );
}

export function discardWindowsAppPack(installDir: string, prepared?: string) {
  if (!prepared || !isPreparedPath(installDir, prepared)) return;
  const discarded = `${prepared}.discarded`;
  try {
    fs.renameSync(prepared, discarded);
  } catch {
    return;
  }
  void fs.promises
    .rm(discarded, { recursive: true, force: true })
    .catch(() => {});
}
