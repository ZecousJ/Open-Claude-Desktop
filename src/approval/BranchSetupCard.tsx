import { useState } from "react";
import { useT } from "../i18n";

const fallbackBranch = "claude/changes";

export function BranchSetupCard({
  suggested,
  busy,
  onContinue,
}: {
  suggested: string;
  busy: boolean;
  onContinue: (content: unknown) => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState<"new" | "stay">("new");
  const name = suggested || fallbackBranch;
  return (
    <section
      className="branch-setup-card"
      data-testid="epitaxy-setup-question-branch"
      aria-busy={busy || undefined}
    >
      <div className="branch-setup-heading">
        <h3>{t("Work on a separate branch?")}</h3>
        <p>
          {t(
            "Recommended: your current branch keeps its history until you merge.",
          )}
        </p>
      </div>
      <div className="branch-setup-options" role="radiogroup">
        <label className="branch-setup-option">
          <input
            type="radio"
            name="branch-choice"
            value="new"
            checked={choice === "new"}
            onChange={() => setChoice("new")}
          />
          <span className="branch-setup-option-copy">
            <span>
              {t("New branch {name}").split("{name}")[0]}
              <code className="font-mono-ui">{name}</code>
              {t("New branch {name}").split("{name}")[1]}
            </span>
            <small>
              {t(
                "Created in this folder from what’s checked out now; Claudex switches to it before changing anything.",
              )}
            </small>
          </span>
        </label>
        <label className="branch-setup-option">
          <input
            type="radio"
            name="branch-choice"
            value="stay"
            checked={choice === "stay"}
            onChange={() => setChoice("stay")}
          />
          <span className="branch-setup-option-copy">
            <span>{t("Stay on the current branch")}</span>
            <small>
              {t("Claudex commits to the branch that’s checked out now.")}
            </small>
          </span>
        </label>
      </div>
      <div className="branch-setup-actions">
        <button
          type="button"
          className="approval-button"
          data-primary="true"
          disabled={busy}
          onClick={() =>
            onContinue(
              choice === "new"
                ? { branch: { kind: "branch", choice: "new", name } }
                : { branch: { kind: "branch", choice: "stay" } },
            )
          }
        >
          {t("Continue")}
        </button>
      </div>
    </section>
  );
}
