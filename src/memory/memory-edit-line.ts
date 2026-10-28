import type { MemoryEditOutcome } from "../../shared/memory-api";
import { currentLocale, formatText, t } from "../i18n";

/** At most this many statements are named; more are counted (the original's rule). */
const namedMost = 3;

function names(removed: string[]) {
  try {
    return new Intl.ListFormat(currentLocale(), {
      type: "conjunction",
    }).format(removed);
  } catch {
    return removed.join(", ");
  }
}

/**
 * The line that says how a Manage-memory change went, as the original words it.
 * The original names memory files; Claudex keeps statements, so it names the
 * statements that went (and counts them past three, as the original counts
 * files).
 */
export function memoryEditLine(outcome: MemoryEditOutcome): string {
  switch (outcome.kind) {
    case "added":
      return t("Added to memory");
    case "updated":
      return t("Updated memory");
    case "noop":
      return t("No changes were made.");
    case "rejected":
      return t("Claudex can’t save that to memory");
    case "too_long":
      return formatText(
        "That edit is too long — memory edits are limited to {max} characters.",
        { max: outcome.limit.toLocaleString(currentLocale()) },
      );
    default: {
      const count = outcome.removed.length;
      const many = count > namedMost;
      const lead = {
        removed: many ? "Removed {count} memory files" : "Removed {names}",
        added_removed: many
          ? "Added to memory, removed {count} memory files"
          : "Added to memory, removed {names}",
        updated_removed: many
          ? "Updated memory, removed {count} memory files"
          : "Updated memory, removed {names}",
      }[outcome.kind];
      return formatText(lead, {
        count: count.toLocaleString(currentLocale()),
        names: many ? "" : names(outcome.removed),
      });
    }
  }
}
