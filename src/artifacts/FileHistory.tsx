import { User, Clock, X } from "../ui/glyphs";
import type { Artifact } from "../ui/ArtifactTypes";
import { currentLocale, formatText, useLocale, useT } from "../i18n";
import { RelativeTime } from "../ui/RelativeTime";
import "./file-history.css";

export function FileHistory({
  path,
  versions,
  activeVersion,
  line,
  lineVersion,
  author,
  onSelect,
  onClearBlame,
}: {
  path: string;
  versions: Artifact[];
  activeVersion: number;
  line?: number;
  lineVersion?: number;
  author: string;
  onSelect: (version: number) => void;
  onClearBlame: () => void;
}) {
  const t = useT();
  useLocale();
  const revision = lineVersion ? versions[lineVersion - 1] : undefined;
  const when = (value: Artifact) =>
    value.updatedAt
      ? new Date(value.updatedAt).toLocaleString(currentLocale(), {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  return (
    <aside className="file-history">
      <header>
        <span>
          <Clock size={16} />
          {t(revision ? "Blame" : "History")}
        </span>
        {revision && (
          <button
            type="button"
            aria-label={t("Back to file history")}
            onClick={onClearBlame}
          >
            <X size={16} />
          </button>
        )}
      </header>
      {revision ? (
        <div className="file-history-blame">
          <div>
            <small>{t("Line")}</small>
            <div className="file-history-mono">
              {path}:{(line ?? 0) + 1}
            </div>
          </div>
          <div>
            <small>{t("Last modified in")}</small>
            <div className="file-history-version">
              <strong className="file-history-mono">
                {formatText("v{version}", { version: lineVersion! })}
              </strong>
              <span
                className={`file-history-badge ${lineVersion === 1 ? "created" : "modified"}`}
              >
                {t(lineVersion === 1 ? "Created" : "Modified")}
              </span>
            </div>
          </div>
          <div>
            <small>{t("Author")}</small>
            <div>{author}</div>
          </div>
          <div>
            <small>{t("When")}</small>
            {revision.updatedAt && (
              <RelativeTime
                createdAt={revision.updatedAt}
                absoluteAfterSeconds={Infinity}
                className="file-history-relative"
              />
            )}
            <small>{when(revision)}</small>
          </div>
        </div>
      ) : (
        <div className="file-history-revisions">
          {versions.length === 0 ? (
            <p>{t("No revision history for this file.")}</p>
          ) : (
            versions
              .map((version, index) => (
                <button
                  key={version.sourceDigest ?? version.id}
                  type="button"
                  aria-current={
                    index + 1 === activeVersion ? "true" : undefined
                  }
                  onClick={() => onSelect(index + 1)}
                >
                  <span className="file-history-version">
                    <strong className="file-history-mono">
                      {formatText("v{version}", { version: index + 1 })}
                    </strong>
                    <span
                      className={`file-history-badge ${index === 0 ? "created" : "modified"}`}
                    >
                      {t(index === 0 ? "Created" : "Modified")}
                    </span>
                  </span>
                  <span>
                    <User size={16} />
                    {author}
                  </span>
                  {version.updatedAt && (
                    <RelativeTime
                      createdAt={version.updatedAt}
                      className="file-history-time"
                    />
                  )}
                </button>
              ))
              .reverse()
          )}
        </div>
      )}
    </aside>
  );
}
