import {
  designSourceCount,
  designSourceLimit,
  designSourcesTotal,
  type DesignSource,
} from "../../../shared/collections-api";

/** Text files a design system can learn from: styles, tokens, markup, code, notes. */
export const designFileExtension =
  /\.(css|scss|sass|less|styl|html?|jsx?|tsx?|mjs|cjs|json|jsonc|md|mdx|txt|svg|vue|svelte|astro|ya?ml|toml|xml)$/i;
const skippedFolder =
  /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|coverage|vendor|__pycache__)(\/|$)/;
/** Files that hold tokens or theme values come first, then styles, then code. */
const tokenName =
  /(token|theme|color|colour|palette|variable|tailwind|brand|design|typography|global|base|reset|style)/i;
/** Files scanned in a dropped folder before it stops looking. */
export const designScanLimit = 600;

/** Lower is read first; undefined for a file a design system cannot use. */
export function designFileRank(path: string): number | undefined {
  if (skippedFolder.test(path) || !designFileExtension.test(path))
    return undefined;
  const name = path.split("/").pop() ?? path;
  const depth = path.split("/").length;
  let rank = 40;
  if (/\.(css|scss|sass|less|styl)$/i.test(name)) rank = 20;
  else if (/\.(json|jsonc|ya?ml|toml)$/i.test(name)) rank = 30;
  else if (/\.(md|mdx|txt)$/i.test(name)) rank = 35;
  if (tokenName.test(name)) rank -= 15;
  if (
    /^(package|package-lock|tsconfig)\.json$|^pnpm-lock|^yarn\.lock/i.test(name)
  )
    return undefined;
  return rank * 10 + Math.min(depth, 9);
}

const pathOf = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
  file.name;

/**
 * The example files a design system keeps from what the person gave: the
 * usable ones, most telling first, at most twenty, each cut at 24,000
 * characters and 160,000 in all.
 */
export async function readDesignSources(
  files: File[],
): Promise<DesignSource[]> {
  const ranked = files
    .map((file) => ({ file, rank: designFileRank(pathOf(file)) }))
    .filter(
      (item): item is { file: File; rank: number } => item.rank !== undefined,
    )
    .sort((a, b) => a.rank - b.rank);
  const sources: DesignSource[] = [];
  let total = 0;
  for (const { file } of ranked) {
    if (sources.length >= designSourceCount) break;
    const text = (await file.text()).slice(0, designSourceLimit);
    if (!text.trim() || text.includes("\u0000")) continue;
    if (total + text.length > designSourcesTotal) break;
    total += text.length;
    sources.push({ name: pathOf(file), text });
  }
  return sources;
}

/** Every file of what was dropped, folders included (up to `designScanLimit`). */
export async function filesFromDrop(
  items: DataTransferItemList | undefined,
  fallback: FileList | undefined,
): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  // webkitGetAsEntry is missing outside the browsers that have folders.
  for (const item of items ? [...items] : []) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return fallback ? [...fallback] : [];
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (files.length >= designScanLimit) return;
    const path = (entry.fullPath || entry.name).replace(/^\//, "");
    if (skippedFolder.test(path + (entry.isDirectory ? "/" : ""))) return;
    if (entry.isFile) {
      if (designFileRank(path) === undefined) return;
      const file = await new Promise<File | undefined>((done) =>
        (entry as FileSystemFileEntry).file(done, () => done(undefined)),
      );
      if (file) {
        Object.defineProperty(file, "webkitRelativePath", { value: path });
        files.push(file);
      }
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((done) =>
          reader.readEntries(done, () => done([])),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
}

/** A name for a new design system from its description: the first line, cut. */
export function nameFromBlurb(blurb: string) {
  const line = blurb.trim().split(/\r?\n/)[0] ?? "";
  const cut = line.split(/[:.–—-]\s/)[0].trim() || line.trim();
  return (
    (cut.length > 60 ? cut.slice(0, 60).trimEnd() : cut) || "Design system"
  );
}

/** New example files added to the list; a file with a name already there replaces it. */
export function mergeSources(
  list: DesignSource[],
  added: DesignSource[],
): DesignSource[] {
  const names = new Set(added.map((item) => item.name));
  return [...list.filter((item) => !names.has(item.name)), ...added].slice(
    0,
    20,
  );
}
