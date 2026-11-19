import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const previewFormats = new Set(["docx", "pptx"]);
const compoundFile = Buffer.from("d0cf11e0a1b11ae1", "hex");
const excelBofRecords = new Set([0x0009, 0x0209, 0x0409, 0x0809]);
const legacyFormats = new Map<
  string,
  { output: "docx" | "xlsx"; filter?: string; accepts?(data: Buffer): boolean }
>([
  [
    "doc",
    {
      output: "docx",
      accepts: (data) => data.subarray(0, 8).equals(compoundFile),
    },
  ],
  [
    "rtf",
    {
      output: "docx",
      filter: "Rich Text Format",
      accepts: (data) => /^\s*\{\\rtf\d/.test(data.toString("utf8", 0, 16)),
    },
  ],
  ["odt", { output: "docx", filter: "writer8" }],
  [
    "xls",
    {
      output: "xlsx",
      accepts: (data) =>
        data.subarray(0, 8).equals(compoundFile) ||
        (data.length >= 4 && excelBofRecords.has(data.readUInt16LE(0))),
    },
  ],
]);

export function normalizedOfficeExtension(extension: string) {
  return legacyFormats.get(extension)?.output;
}

export class OfficeRuntimeUnavailable extends Error {}

/** A private headless profile prevents interference with open office documents. */
export async function convertOfficeDocument({
  runtime,
  data,
  extension,
  output,
  signal,
}: {
  runtime: string;
  data: Buffer;
  extension: string;
  output: "pdf" | "docx" | "xlsx";
  signal: AbortSignal;
}) {
  const format = legacyFormats.get(extension);
  if (
    output === "pdf"
      ? !previewFormats.has(extension)
      : format?.output !== output
  )
    throw Error("Unsupported document type");
  if (format?.accepts?.(data) === false)
    throw Error("Invalid Office document.");
  const executable =
    process.platform === "darwin"
      ? path.join(runtime, "LibreOffice.app/Contents/MacOS/soffice")
      : path.join(
          runtime,
          "program",
          process.platform === "win32" ? "soffice.exe" : "soffice",
        );
  try {
    await fs.access(executable, fs.constants.X_OK);
  } catch {
    throw new OfficeRuntimeUnavailable(
      "Document conversion is unavailable on this host.",
    );
  }
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-document-"),
  );
  try {
    const profile = path.join(temporary, "profile");
    await fs.mkdir(path.join(profile, "user"), { recursive: true });
    await fs.writeFile(
      path.join(profile, "user/registrymodifications.xcu"),
      '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateMode" oor:op="fuse"><value>0</value></prop></item></oor:items>',
    );
    const input = path.join(temporary, "document." + extension);
    await fs.writeFile(input, data, { mode: 0o600 });
    const args = [
      "-env:UserInstallation=" + pathToFileURL(profile).href,
      "--headless",
      "--nologo",
      "--nodefault",
      "--norestore",
      ...(format?.filter ? ["--infilter=" + format.filter] : []),
      "--convert-to",
      output,
      "--outdir",
      temporary,
      input,
    ];
    // Imported documents cannot load remote images or external links on macOS.
    const command =
      process.platform === "darwin" ? "/usr/bin/sandbox-exec" : executable;
    const commandArgs =
      process.platform === "darwin"
        ? [
            "-p",
            '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))',
            executable,
            ...args,
          ]
        : args;
    await exec(command, commandArgs, {
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      signal,
    });
    const result = await fs.readFile(
      path.join(temporary, `document.${output}`),
    );
    if (output === "pdf" && result.length > 64_000_000)
      throw Error("Converted document too large");
    return result;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
