/** Organize original Claude-only evidence locally; never add proprietary media to Git. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const raw = path.join(repo, "work", "fidelity");
const output = path.join(repo, "work", "原版 Claude 参考资料");
const screenshots = path.join(raw, "screenshots");
const recordings = path.join(raw, "recordings");
const validImage = /\.(?:png|jpe?g)$/i;
const validVideo = /\.(?:mov|mp4)$/i;
const excludedStill =
  /(?:comparison|contact|local-|composited|attempt|diagnosis)/i;
if (!fs.existsSync(screenshots) || !fs.existsSync(recordings))
  throw Error("Original evidence source folders are missing.");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const indexed = [];
function add(source, relative, category) {
  const target = path.join(output, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const hash = createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
  if (fs.existsSync(target)) {
    const existing = createHash("sha256")
      .update(fs.readFileSync(target))
      .digest("hex");
    if (hash !== existing)
      throw Error(`Target differs; preserved without overwrite: ${relative}`);
  } else {
    try {
      fs.linkSync(source, target);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
  indexed.push({
    category,
    path: relative,
    source: path.relative(repo, source),
    bytes: fs.statSync(source).size,
    sha256: hash,
  });
}
const originalVideos = [];
for (const entry of fs.readdirSync(recordings, { withFileTypes: true })) {
  if (!entry.isFile() || !validVideo.test(entry.name)) continue;
  const source = path.join(recordings, entry.name),
    metadata = `${source}.json`;
  if (!fs.existsSync(metadata))
    throw Error(`Missing recording provenance metadata: ${entry.name}`);
  const data = JSON.parse(fs.readFileSync(metadata, "utf8"));
  if (data.bundle === "com.anthropic.claudefordesktop")
    originalVideos.push({
      source,
      metadata,
      stem: path.parse(entry.name).name,
    });
}
const stems = new Set(originalVideos.map((value) => value.stem));
for (const entry of fs.readdirSync(screenshots, { withFileTypes: true })) {
  if (!entry.isFile() || !validImage.test(entry.name)) continue;
  if (
    !entry.name.startsWith("claude-") &&
    !entry.name.startsWith("workflow-user-") &&
    !entry.name.startsWith("single-agent-user-")
  )
    continue;
  add(
    path.join(screenshots, entry.name),
    path.join("截图", entry.name),
    "original-screenshot",
  );
}
for (const video of originalVideos) {
  const name = path.basename(video.source);
  add(video.source, path.join("录屏", name), "original-recording");
  add(
    video.metadata,
    path.join("录屏元数据", name + ".json"),
    "recording-provenance",
  );
  const analysis = path.join(recordings, video.stem + "-analysis");
  if (!fs.existsSync(analysis)) continue;
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const source = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(source);
      else if (entry.isFile())
        add(
          source,
          path.join("逐帧分析", path.relative(recordings, source)),
          "original-recording-analysis",
        );
    }
  };
  walk(analysis);
}
for (const entry of fs.readdirSync(recordings, { withFileTypes: true })) {
  if (
    !entry.isFile() ||
    !validImage.test(entry.name) ||
    excludedStill.test(entry.name)
  )
    continue;
  const stem = path.parse(entry.name).name;
  if (
    !entry.name.startsWith("claude-") &&
    !entry.name.startsWith("reference-") &&
    ![...stems].some((value) => stem.startsWith(value + "-"))
  )
    continue;
  add(
    path.join(recordings, entry.name),
    path.join("关键帧", entry.name),
    "original-derived-still",
  );
}
indexed.sort((a, b) => a.path.localeCompare(b.path, "zh-Hans"));
const categoryCount = Object.fromEntries(
  [...new Set(indexed.map((entry) => entry.category))].map((category) => [
    category,
    indexed.filter((entry) => entry.category === category).length,
  ]),
);
const index = {
  version: 1,
  createdAt: new Date().toISOString(),
  source: raw,
  classification:
    "Recording sidecar bundle ID com.anthropic.claudefordesktop; original/user screenshot names; derived frames from those recordings",
  categories: categoryCount,
  files: indexed,
};
const indexFile = path.join(output, "文件清单.json");
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + "\n", {
  mode: 0o600,
});
const readme = `# 原版 Claude 参考资料\n\n这里仅整理原版 Claude 的静态截图、原版窗口录屏、录制元数据、从原版录屏提取的关键帧及逐帧分析。没有包含 Claudex 本地截图或录屏。\n\n- 截图：${categoryCount["original-screenshot"] ?? 0} 张\n- 原版录屏：${categoryCount["original-recording"] ?? 0} 段；同名元数据中的 bundle 为 com.anthropic.claudefordesktop\n- 关键帧：${categoryCount["original-derived-still"] ?? 0} 张\n- 逐帧分析文件：${categoryCount["original-recording-analysis"] ?? 0} 个\n\n文件清单.json 记录每个文件的原始路径、大小与 SHA-256。媒体采用同磁盘硬链接，不额外复制大文件；任一入口删除不会删除另一入口，但修改内容会同时影响两边，因此请只读使用。本目录位于 Git 忽略的 work/ 下，未上传到仓库。\n\n截图只能证明静态状态；某些悬浮、持续悬浮、展开/收起、失败态等原版录屏仍缺失，不应将本目录视为像素级验收完成。\n`;
fs.writeFileSync(path.join(output, "说明.md"), readme, { mode: 0o600 });
console.log(
  JSON.stringify({
    folder: output,
    categories: categoryCount,
    total: indexed.length,
    bytes: indexed.reduce((sum, item) => sum + item.bytes, 0),
  }),
);
