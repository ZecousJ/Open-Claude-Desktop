import type JSZip from "jszip";
import { t } from "../i18n";
import { readFrontMatter } from "../collections/customize/skill-preview";
import { PluginOperationRetired } from "./usePlugins";

export async function sendPluginArchive(
  file: File,
  overwrite = false,
  stopped = () => false,
  bridge = window.desktop,
  ownsAccount = () =>
    typeof window !== "undefined" && window.desktop === bridge,
) {
  if (!ownsAccount()) throw new PluginOperationRetired();
  if (typeof bridge?.uploadPlugin !== "function")
    throw new Error(t("Plugin upload is unavailable."));
  const session = await bridge.uploadPlugin({
    action: "begin",
    name: file.name,
  });
  const cancel = async () => {
    // A route-close may cancel its own staging session; an account change
    // must never send an old upload id through the replacement account.
    if (ownsAccount())
      await bridge
        .uploadPlugin({ action: "cancel", id: session.id })
        .catch(() => {});
  };
  const active = () => {
    if (!ownsAccount()) throw new PluginOperationRetired();
    if (stopped()) throw new Error("Upload stopped");
  };
  try {
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      active();
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.readAsDataURL(file.slice(offset, offset + 1024 * 1024));
      });
      active();
      await bridge.uploadPlugin({ action: "append", id: session.id, data });
    }
    active();
    const result = await bridge.uploadPlugin({
      action: "finish",
      id: session.id,
      overwrite,
    });
    // A finish receipt is authoritative even when the user just left the
    // page. A staging cancellation cannot undo an already committed install.
    if (!ownsAccount()) throw new PluginOperationRetired();
    if (result.conflict) await cancel();
    return result;
  } catch (error) {
    await cancel();
    throw error;
  }
}

export async function previewPluginArchive(
  file: File,
): Promise<
  { name: string; description?: string; manifestName: string } | undefined
> {
  if (file.size > 30 * 1024 * 1024) return undefined;
  try {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const manifests = Object.keys(zip.files).filter((name) =>
      /^(?:[^/]+\/)?\.claude-plugin\/plugin\.json$/.test(name),
    );
    const entry =
      manifests.length === 1 ? zip.file(manifests[0]) : zip.file("SKILL.md");
    if (!entry) return undefined;
    const bytes: Uint8Array[] = [];
    let length = 0;
    const contents = await new Promise<string>((resolve, reject) => {
      const stream = (
        entry as typeof entry & {
          internalStream(
            type: "uint8array",
          ): JSZip.JSZipStreamHelper<Uint8Array>;
        }
      ).internalStream("uint8array");
      stream.on("data", (chunk) => {
        length += chunk.length;
        if (length > 1024 * 1024) {
          stream.pause();
          reject(Error("Invalid zip file"));
        } else bytes.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => {
        void new Blob(bytes as BlobPart[]).text().then(resolve, reject);
      });
      stream.resume();
    });
    const manifest =
      manifests.length === 1 ? JSON.parse(contents) : readFrontMatter(contents);
    if (typeof manifest.name !== "string") return undefined;
    return {
      name: manifest.name,
      description:
        typeof manifest.description === "string"
          ? manifest.description
          : undefined,
      manifestName: manifests.length === 1 ? "plugin.json" : "SKILL.md",
    };
  } catch {
    return undefined;
  }
}
