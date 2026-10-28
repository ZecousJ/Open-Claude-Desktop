import type { Approval, Item } from "../../shared/types";
import { DiffLines } from "../diff/DiffLines";
import { t } from "../i18n";

/** The biggest change an approval draws (the original's 200,000 characters). */
export const approvalPreviewLimit = 200_000;
import { fileChangeDiff, languageForPath } from "../diff/diff-model";
import { permissionRows } from "./approval-model";

/**
 * The file line under the title: relative to the working folder inside it, the
 * absolute path outside it.
 */
export function displayPath(path: string, cwd?: string) {
  if (!cwd) return path;
  const root = cwd.replace(/[\\/]+$/, "");
  const inside = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
  return inside ? path.slice(root.length + 1) : path;
}

/** Command approval: reason line and the command in a code box. */
export function CommandBody({ params }: { params: any }) {
  const network = params?.networkApprovalContext;
  return (
    <>
      <p className="approval-text">
        {params?.reason ||
          (network?.host
            ? `This command wants to reach ${network.host}`
            : "This command requires approval")}
      </p>
      {params?.command && <pre className="approval-code">{params.command}</pre>}
    </>
  );
}

/** File approval: name, full path, then each file's path over its diff. */
export function FileChangeBody({
  approval,
  item,
  cwd,
}: {
  approval: Approval;
  item?: Item;
  /** The conversation's working folder. */
  cwd?: string;
}) {
  const changes = item?.changes ?? [];
  const root = approval.params?.grantRoot as string | undefined;
  const reason = approval.params?.reason as string | undefined;
  const paths = [...new Set(changes.map((change) => change.path))];
  return (
    <>
      {paths.length > 0 && (
        <p className="approval-text">
          {paths.length === 1
            ? displayPath(paths[0], cwd)
            : `${paths.length} files`}
        </p>
      )}
      {reason && <p className="approval-text">{reason}</p>}
      {(paths.length > 0 || root) && (
        <pre className="approval-code">{root ?? paths.join("\n")}</pre>
      )}
      {changes.map((change, index) => {
        // Past 200,000 characters the change isn't drawn here.
        if ((change.diff?.length ?? 0) > approvalPreviewLimit)
          return (
            <div className="approval-file" key={`${change.path}:${index}`}>
              <p className="approval-text approval-path">{change.path}</p>
              <p className="approval-text">
                {t(
                  "Preview unavailable — this change is too large to show here (over 200,000 characters). The full change appears in the conversation after it runs.",
                )}
              </p>
            </div>
          );
        const diff = fileChangeDiff(change);
        const lines = diff.hunks.flatMap((hunk) => hunk.lines);
        if (!lines.length) return null;
        return (
          <div className="approval-file" key={`${change.path}:${index}`}>
            <p className="approval-text approval-path">{change.path}</p>
            <div
              className="approval-diff diff-box diff-lines"
              data-new={diff.status === "added" || undefined}
            >
              <DiffLines
                lines={lines}
                language={languageForPath(change.path)}
                markFirst={diff.status === "added"}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Additional permissions as readable rows instead of the raw profile. */
export function PermissionsBody({ params }: { params: any }) {
  const rows = permissionRows(params?.permissions);
  return (
    <>
      {params?.reason && <p className="approval-text">{params.reason}</p>}
      {rows.length > 0 && (
        <dl className="approval-code approval-permissions">
          {rows.map((row, index) => (
            <div key={index}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {params?.cwd && (
        <p className="approval-text approval-path">From {params.cwd}</p>
      )}
    </>
  );
}
