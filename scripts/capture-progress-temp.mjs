import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const root =
  "/Users/zecous/.codex/worktrees/reference-checklist-update/Claudex";
const source = path.join(
  root,
  "work/原版参考核对-2026-09-24/参考素材需求表.xlsx",
);
const output = path.join(
  root,
  "outputs/01a0d663-1f65-79a1-a51e-f10e1f482d12/参考素材需求表.xlsx",
);
const updatePath = process.argv[2];
if (!updatePath) throw new Error("Pass a capture-update JSON file.");

const updates = JSON.parse(await fs.readFile(updatePath, "utf8"));
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(output));
const sheet = workbook.worksheets.getItem("需求清单");
const rowById = new Map(
  sheet.getRange("A2:A1627").values.map((row, i) => [String(row[0]), i + 2]),
);

function appendFileNames(current, additions) {
  const values = String(current ?? "")
    .split(/[;,，；\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of additions || []) {
    if (item && !values.includes(item)) values.push(item);
  }
  return values.join(", ");
}

function appendNote(current, value) {
  const previous = String(current ?? "").trim();
  if (!value || previous.includes(value)) return previous;
  return previous ? previous + "\n" + value : value;
}

for (const item of updates) {
  const row = rowById.get(item.id);
  if (!row) throw new Error("Unknown requirement ID: " + item.id);
  const status = item.status || "部分提供";
  sheet.getRange("Y" + row).values = [
    [status === "已提供" ? "已有可用参考" : "部分已有"],
  ];
  const filenames = sheet.getRange("Z" + row).values[0][0];
  sheet.getRange("Z" + row).values = [
    [appendFileNames(filenames, item.files) || null],
  ];
  sheet.getRange("AA" + row).values = [[item.remaining || null]];
  sheet.getRange("AD" + row).values = [[status]];
  const notes = sheet.getRange("AE" + row).values[0][0];
  sheet.getRange("AE" + row).values = [[appendNote(notes, item.note) || null]];
}

workbook.recalculate();
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(output);
await fs.copyFile(output, source);
console.log("UPDATED", updates.map((item) => item.id).join(","));
