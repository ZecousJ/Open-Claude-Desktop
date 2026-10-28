import {
  knowledgeExtensions,
  type ProjectKnowledge,
} from "../../../shared/collections-api";
import { formatText, t } from "../../i18n";

/** Why the knowledge area refuses everything once the project is full. */
export const capacityReason =
  "Project knowledge at capacity. Remove an existing file in order to add to knowledge";

/** The project's files use all of its capacity. */
export const knowledgeFull = (knowledge: ProjectKnowledge | undefined) =>
  Boolean(knowledge && knowledge.bytes >= knowledge.limit);

/** At most this many files per call (the main process's own limit). */
export const knowledgeBatch = 12;

/**
 * MIME types a drag shows that project knowledge can never take: pictures,
 * sound, video, fonts, archives and office documents. Text, PDFs and types
 * the system doesn't name (Markdown, source files) may pass; their names
 * are checked on the drop.
 */
const refusedType =
  /^(image|audio|video|font)\/|^application\/(zip|x-zip|gzip|x-gzip|x-tar|x-7z|x-rar|vnd\.|msword|x-msdownload|x-apple-diskimage)/;

/**
 * Whether a drag over the knowledge area is refused while it is still a
 * drag (live: the zone turns red when the items don't match what it takes).
 */
export function knowledgeRefuses(
  items: Pick<DataTransferItemList, "length"> &
    ArrayLike<Pick<DataTransferItem, "kind" | "type">>,
  knowledge: ProjectKnowledge | undefined,
  documents = false,
): boolean {
  if (knowledgeFull(knowledge)) return true;
  const files = Array.from(items).filter((item) => item.kind === "file");
  return (
    files.length > 0 &&
    files.every(
      (item) =>
        !(
          documents &&
          /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)$/.test(
            item.type,
          )
        ) && refusedType.test(item.type),
    )
  );
}

const extension = (name: string) =>
  (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

export interface DroppedFile {
  name: string;
  size: number;
  type: string;
}

/** Which dropped files go to the project and what to say about the rest. */
export function sortKnowledgeDrop<T extends DroppedFile>(
  files: readonly T[],
  knowledge: Pick<ProjectKnowledge, "bytes" | "limit" | "fileLimit">,
  extensions: readonly string[] = knowledgeExtensions,
): { accepted: T[]; notices: string[] } {
  const accepted: T[] = [];
  const notices = new Set<string>();
  let room = Math.max(0, knowledge.limit - knowledge.bytes);
  for (const file of files) {
    // A folder arrives as an empty file without a type.
    if (!file.type && file.size === 0 && !extension(file.name)) {
      notices.add(t("Folders can't be added to project knowledge."));
      continue;
    }
    if (!extensions.includes(extension(file.name))) {
      notices.add(
        formatText(
          "{name} can't be added: project files can be text files or PDFs.",
          { name: file.name },
        ),
      );
      continue;
    }
    if (file.size > knowledge.fileLimit) {
      notices.add(
        formatText("{name} is too large. Project files can be up to 10 MB.", {
          name: file.name,
        }),
      );
      continue;
    }
    if (file.size > room) {
      notices.add(t(capacityReason));
      continue;
    }
    room -= file.size;
    accepted.push(file);
  }
  return { accepted, notices: [...notices] };
}
