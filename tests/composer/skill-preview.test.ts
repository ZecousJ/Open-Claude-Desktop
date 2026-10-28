import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  formatFileSize,
  leftOutMessage,
  previewSkillFile,
  readFrontMatter,
} from "../../src/collections/customize/skill-preview";

/** A one-file zip archive, stored or deflated. */
function zip(name: string, text: string, deflate = false): Uint8Array {
  const raw = Buffer.from(text);
  const data = deflate ? zlib.deflateRawSync(raw) : raw;
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  const at = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}
const file = (name: string, bytes: Uint8Array | string) =>
  new File([bytes as BlobPart], name);

test("front matter: quoted, plain and folded values", () => {
  assert.deepEqual(
    readFrontMatter(
      '---\nname: "weekly-report"\ndescription: Makes reports\n---\nx',
    ),
    { name: "weekly-report", description: "Makes reports" },
  );
  assert.deepEqual(
    readFrontMatter("---\nname: a\ndescription: >\n  one\n  two\n---\n"),
    { name: "a", description: "one two" },
  );
  assert.deepEqual(readFrontMatter("no front matter"), {});
});

test("preview of a markdown file names it from its front matter", async () => {
  const preview = await previewSkillFile(
    file("x.md", "---\nname: alpha\ndescription: First skill\n---\n"),
  );
  assert.deepEqual(preview, { name: "alpha", description: "First skill" });
});

test("preview of a zip reads SKILL.md, stored or deflated", async () => {
  const text = "---\nname: beta\ndescription: Second\n---\n";
  for (const deflate of [false, true]) {
    const preview = await previewSkillFile(
      file("beta.zip", zip("SKILL.md", text, deflate)),
    );
    assert.deepEqual(preview, { name: "beta", description: "Second" });
  }
  const nested = await previewSkillFile(
    file("beta.skill", zip("beta/SKILL.md", text, true)),
  );
  assert.equal(nested.name, "beta");
});

test("a file that is not a zip is an invalid zip file (R-1153)", async () => {
  const preview = await previewSkillFile(
    file("cua-invalid-skill-1790514337443.zip", "not a zip at all, just bytes"),
  );
  assert.equal(preview.error, "Invalid zip file");
  assert.equal(preview.name, "cua-invalid-skill-1790514337443");
});

test("a zip without SKILL.md says what it needs", async () => {
  const preview = await previewSkillFile(
    file("a.zip", zip("readme.txt", "hi")),
  );
  assert.match(preview.error ?? "", /needs one SKILL\.md/);
});

test("refused extensions are named in the original's words", () => {
  assert.equal(
    leftOutMessage(1, 1),
    "Skill files must have a .skill, .zip, or .md file extension.",
  );
  assert.equal(
    leftOutMessage(1, 3),
    "1 file was left out: skill files must have a .skill, .zip, or .md file extension.",
  );
  assert.equal(
    leftOutMessage(2, 3),
    "2 files were left out: skill files must have a .skill, .zip, or .md file extension.",
  );
});

test("sizes read like the capture", () => {
  assert.equal(formatFileSize(54), "54B");
  assert.equal(formatFileSize(1536), "1.5KB");
  assert.equal(formatFileSize(3 * 1024 * 1024), "3.0MB");
});
