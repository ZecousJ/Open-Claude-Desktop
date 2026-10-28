import { SquareDashed } from "lucide-react";
import { X } from "../ui/glyphs";
import { linearIssueLabel, type LinearIssue } from "../../shared/linear-api";
import { api } from "../desktop-api";
import { formatText } from "../i18n";
import "./linear.css";

// Issue attachment uses Wr, not an uploaded file.
export default function LinearIssuePill({
  issue,
  onRemove,
}: {
  issue: LinearIssue;
  onRemove: () => void;
}) {
  const label = linearIssueLabel(issue);
  return (
    <span className="linear-issue-pill">
      <button
        type="button"
        className="linear-issue-pill-body"
        title={label}
        onClick={() => void api.openExternal(issue.url)}
        onKeyDown={(event) => {
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            onRemove();
          }
        }}
      >
        <SquareDashed size={12} aria-hidden="true" />
        <span data-no-translate>{label}</span>
      </button>
      <button
        type="button"
        className="linear-issue-pill-remove"
        aria-label={formatText("Remove {name}", { name: label })}
        onClick={onRemove}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
}
