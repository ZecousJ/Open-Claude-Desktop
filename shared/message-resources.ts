import type { Item } from "./types";

export interface McpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
}

export interface McpResourceFile {
  name: string;
  mimeType: string;
  base64: string;
}

export interface McpResourceRead extends McpResourceFile {
  downloadId?: string;
  byteLength?: number;
}

export const resourceChunkBytes = 3 * 256 * 1024;
export const maxResourceBytes = 104_857_600;

export function validResourceBase64(text: string) {
  const padding = text.indexOf("=");
  return (
    text.length % 4 === 0 &&
    !/[^A-Za-z0-9+/=]/.test(text) &&
    (padding < 0 ||
      (padding >= text.length - 2 && /^={1,2}$/.test(text.slice(padding))))
  );
}

export function validResourceFile(file: McpResourceFile) {
  return (
    typeof file?.name === "string" &&
    file.name.length > 0 &&
    file.name.length <= 16_384 &&
    typeof file.mimeType === "string" &&
    file.mimeType.length <= 256 &&
    typeof file.base64 === "string" &&
    file.base64.length <= Math.ceil(maxResourceBytes / 3) * 4 &&
    validResourceBase64(file.base64)
  );
}

export type ToolDisplayContent =
  | { type: "rich_link"; link: { resource_type: string; url: string } }
  | { type: "rich_content"; content: { resource_type: string; url: string }[] };

export function resourceLinks(item: Item): McpResourceLink[] {
  if (item.result?.isError || item.result?.is_error || item.success === false)
    return [];
  const content = item.result?.content ?? item.contentItems ?? [];
  const explicit = item.result?.resource_links ?? item.resource_links ?? [];
  const parts = [
    ...(Array.isArray(explicit) ? explicit : []),
    ...(Array.isArray(content)
      ? content.filter((part) => part?.type === "resource_link")
      : []),
  ];
  const seen = new Set<string>();
  const label = (value: unknown) =>
    typeof value === "string" &&
    value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
      ? value.trim().slice(0, 512)
      : undefined;
  return parts.flatMap((part) => {
    if (
      typeof part?.uri !== "string" ||
      part.uri.length > 2048 ||
      /[\s\u0000-\u001f\u007f-\u009f]/u.test(part.uri) ||
      seen.size >= 50 ||
      seen.has(part.uri)
    )
      return [];
    try {
      new URL(part.uri);
    } catch {
      return [];
    }
    seen.add(part.uri);
    const title = label(part.title);
    const mimeType = label(part.mimeType ?? part.mime_type);
    return [
      {
        type: "resource_link" as const,
        uri: part.uri,
        name: label(part.name) ?? resourceBasename(part.uri) ?? part.uri,
        ...(title ? { title } : {}),
        ...(mimeType ? { mimeType } : {}),
      },
    ];
  });
}

function resourceBasename(uri: string) {
  let path: string;
  try {
    path = new URL(uri).pathname;
  } catch {
    path = uri;
  }
  const name = path.replace(/\/+$/, "").split("/").at(-1);
  try {
    return decodeURIComponent(name ?? "");
  } catch {
    return name;
  }
}

export function resourceName(link: McpResourceLink) {
  const clean = (text: string) =>
    text
      .replace(
        /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
        "",
      )
      .slice(0, 120)
      .trim();
  return (
    clean(link.title ?? "") ||
    clean(link.name) ||
    clean(resourceBasename(link.uri) ?? "") ||
    clean(link.uri) ||
    "resource"
  );
}

export function resourceDownloadName(link: McpResourceLink, mimeType?: string) {
  const name = resourceName(link).replace(/[\\/]/g, "_");
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  const allowed = new Set([
    "pdf",
    "txt",
    "md",
    "csv",
    "tsv",
    "json",
    "ndjson",
    "yaml",
    "yml",
    "toml",
    "log",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "zip",
    "tar",
    "gz",
    "docx",
    "xlsx",
    "pptx",
  ]);
  const extensions: Record<string, string> = {
    "application/pdf": "pdf",
    "application/json": "json",
    "application/zip": "zip",
    "application/x-ndjson": "ndjson",
    "application/yaml": "yaml",
    "application/x-yaml": "yaml",
    "application/toml": "toml",
    "application/x-tar": "tar",
    "application/gzip": "gz",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "pptx",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
  };
  const extension = match?.[1].toLowerCase();
  const suffix =
    extension && allowed.has(extension)
      ? extension
      : (extensions[
          (mimeType ?? link.mimeType ?? "").split(";")[0].trim().toLowerCase()
        ] ?? "bin");
  return `${(match ? name.slice(0, -match[0].length) : name).trim() || "resource"}.${suffix}`;
}

// .
export function electionInfoSource(items: Item[]) {
  for (const item of items) {
    if (
      item.tool !== "us_election_info" ||
      item.status === "failed" ||
      item.lifecycleStatus === "failed" ||
      item.lifecycleStatus === "interrupted" ||
      item.success === false ||
      item.cancelled ||
      item.result?.isError ||
      item.result?.is_error ||
      item.result?.cancelled
    )
      continue;
    const display = item.result?.display_content ?? item.display_content;
    const links =
      display?.type === "rich_link"
        ? [display.link]
        : display?.type === "rich_content" && Array.isArray(display.content)
          ? display.content
          : [];
    for (const link of links) {
      if (
        link?.resource_type !== "democracy_works_election_info" ||
        typeof link.url !== "string"
      )
        continue;
      try {
        const url = new URL(link.url);
        if (
          url.protocol === "https:" &&
          url.hostname === "voting.democracy.works" &&
          !url.port &&
          !url.username &&
          !url.password
        )
          return url.href;
      } catch {}
    }
  }
}
