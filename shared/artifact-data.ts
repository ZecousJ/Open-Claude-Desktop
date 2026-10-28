export interface ArtifactDataUsage {
  bytes: number;
  maxBytes: number;
  documents?: number;
  maxDocuments?: number;
  files?: { bytes: number; maxBytes: number; files: number; maxFiles: number };
  canRequestLimit?: boolean;
}

export type ArtifactStorageResource = "data" | "files";

export type ArtifactDataRequest = (
  | { method: "get" | "delete"; key: string }
  | { method: "set"; key: string; value: string }
  | { method: "list"; prefix?: string }
) & { resource?: ArtifactStorageResource };

/** Notice thresholds and optional asset line. */
export function artifactStorageLines(usage: ArtifactDataUsage) {
  const line = (
    resource: ArtifactStorageResource,
    bytes: number,
    maxBytes: number,
    count: number,
    maxCount: number,
  ) => {
    const atDocumentCap = resource === "data" && count >= maxCount;
    const full = bytes >= maxBytes || count >= maxCount;
    return {
      resource,
      bytes,
      maxBytes,
      atDocumentCap,
      full,
      low: full || bytes >= maxBytes * 0.8,
    };
  };
  return [
    line(
      "data",
      usage.bytes,
      usage.maxBytes,
      usage.documents ?? 0,
      usage.maxDocuments ?? Infinity,
    ),
    ...(usage.files && (usage.files.files > 0 || usage.files.bytes > 0)
      ? [
          line(
            "files",
            usage.files.bytes,
            usage.files.maxBytes,
            usage.files.files,
            usage.files.maxFiles,
          ),
        ]
      : []),
  ];
}

export type ArtifactDataResult =
  | { key: string; value: string }
  | { key: string; deleted: boolean }
  | { keys: string[]; prefix?: string }
  | null;

export const artifactDataMessage = "claudex-artifact-data";
export const artifactDataResult = "claudex-artifact-data-result";
export const artifactDataChanged = "claudex-artifact-data-changed";

/** Decimal storage figures. */
export function artifactDataSize(bytes: number, locale: string) {
  if (bytes < 1000) return `${bytes} B`;
  const [unit, divisor] =
    bytes >= 1e9
      ? ["gigabyte", 1e9]
      : bytes >= 1e6
        ? ["megabyte", 1e6]
        : ["kilobyte", 1e3];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: String(unit),
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(bytes / Number(divisor));
}
