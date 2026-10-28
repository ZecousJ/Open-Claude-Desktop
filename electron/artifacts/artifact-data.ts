import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { artifactDataInput } from "../../shared/artifact-data-input";
import type {
  ArtifactDataResult,
  ArtifactDataUsage,
  ArtifactStorageResource,
} from "../../shared/artifact-data";
import { artifactStorageLines } from "../../shared/artifact-data";

const maxBytes = 20 * 1024 * 1024;
const maximumBytes = maxBytes * 8;
const maximumEntries = 80_000;

export class ArtifactData {
  constructor(private root: string) {}

  private file(identity: string, resource: ArtifactStorageResource = "data") {
    const name = createHash("sha256").update(identity).digest("hex");
    return path.join(
      this.root,
      resource === "files" ? "artifact-files" : "artifact-data",
      `${name}.json`,
    );
  }

  private read(
    identity: string,
    resource: ArtifactStorageResource = "data",
  ): Record<string, string> {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.file(identity, resource), "utf8"),
      );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("The request failed.");
      const entries = Object.entries(value);
      if (!entries.every(([, value]) => typeof value === "string"))
        throw new Error("The request failed.");
      return Object.assign(Object.create(null), value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return Object.create(null);
      throw error;
    }
  }

  private limitsFile() {
    return path.join(this.root, "artifact-storage-limits.json");
  }

  private storedBytes(resource: ArtifactStorageResource) {
    const folder = path.dirname(this.file("", resource));
    if (!fs.existsSync(folder)) return 0;
    return fs
      .readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .reduce(
        (total, name) => total + fs.statSync(path.join(folder, name)).size,
        0,
      );
  }

  private limits() {
    const defaults = {
      data: { bytes: maxBytes, entries: 10_000 },
      files: { bytes: maxBytes, entries: 1000 },
    };
    try {
      const stored = JSON.parse(fs.readFileSync(this.limitsFile(), "utf8"));
      for (const resource of ["data", "files"] as const) {
        const value = stored?.[resource];
        if (
          Number.isSafeInteger(value?.bytes) &&
          value.bytes >= maxBytes &&
          value.bytes <= maximumBytes &&
          Number.isSafeInteger(value?.entries) &&
          value.entries >= defaults[resource].entries &&
          value.entries <= maximumEntries
        )
          defaults[resource] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return defaults;
  }

  usage(identity: string): ArtifactDataUsage {
    const data = this.read(identity);
    const files = this.read(identity, "files");
    const limits = this.limits();
    const usage = {
      bytes: this.storedBytes("data"),
      maxBytes: limits.data.bytes,
      documents: Object.keys(data).length,
      maxDocuments: limits.data.entries,
      files: {
        bytes: this.storedBytes("files"),
        maxBytes: limits.files.bytes,
        files: Object.keys(files).length,
        maxFiles: limits.files.entries,
      },
    };
    return {
      ...usage,
      canRequestLimit: artifactStorageLines(usage).some(
        (line) =>
          line.low &&
          (limits[line.resource].bytes < maximumBytes ||
            limits[line.resource].entries < maximumEntries),
      ),
    };
  }

  /**
   * The local account host approves quota requests instead of mailing
   * Anthropic.
   */
  requestLimit(identity: string): ArtifactDataUsage {
    const limits = this.limits();
    for (const line of artifactStorageLines(this.usage(identity))) {
      if (!line.low) continue;
      const limit = limits[line.resource];
      limit.bytes = Math.min(maximumBytes, limit.bytes * 2);
      limit.entries = Math.min(maximumEntries, limit.entries * 2);
    }
    const file = this.limitsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(limits), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return this.usage(identity);
  }

  request(identity: string, raw: unknown): ArtifactDataResult {
    const input = artifactDataInput.parse(raw);
    const resource = input.resource ?? "data";
    const data = this.read(identity, resource);
    const limits = this.limits()[resource];
    if (input.method === "get")
      return Object.hasOwn(data, input.key)
        ? { key: input.key, value: data[input.key] }
        : null;
    if (input.method === "list")
      return {
        keys: Object.keys(data).filter((key) =>
          key.startsWith(input.prefix ?? ""),
        ),
        ...(input.prefix ? { prefix: input.prefix } : {}),
      };
    const existed = Object.hasOwn(data, input.key);
    if (input.method === "delete" && !existed)
      return { key: input.key, deleted: false };
    if (input.method === "set") data[input.key] = input.value;
    else delete data[input.key];
    const text = JSON.stringify(data);
    if (
      input.method === "set" &&
      (Buffer.byteLength(text) > limits.bytes ||
        Object.keys(data).length > limits.entries)
    )
      throw new Error("Artifact storage limit reached.");
    const file = this.file(identity, resource);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const files = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.endsWith(".json"));
    const otherBytes = files.reduce((total, name) => {
      const other = path.join(path.dirname(file), name);
      return total + (other === file ? 0 : fs.statSync(other).size);
    }, 0);
    if (
      input.method === "set" &&
      otherBytes + Buffer.byteLength(text) > limits.bytes
    )
      throw new Error("Artifact storage limit reached.");
    if (files.length >= 1000 && !fs.existsSync(file))
      throw new Error("Artifact storage limit reached.");
    fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return input.method === "set"
      ? { key: input.key, value: input.value }
      : { key: input.key, deleted: existed };
  }
}
