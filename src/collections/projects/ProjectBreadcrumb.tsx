import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Project } from "../../../shared/types";
import { formatText, t, useLocale } from "../../i18n";
import { isEditEndKey } from "../../ui/ime";

/** Entity crumb and inline edit. */
export function ProjectBreadcrumb({
  project,
  onBack,
  onSave,
  onError,
  backHref,
  children,
}: {
  project: Project;
  onBack: () => void;
  onSave: (project: Project) => Promise<void>;
  onError: (error: unknown) => void;
  /** A web breadcrumb keeps native open-in-new-tab and copy-link behavior. */
  backHref?: string;
  children?: ReactNode;
}) {
  useLocale();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [optimistic, setOptimistic] = useState<{
    before: string;
    name: string;
  }>();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const entering = useRef(false);
  const refocus = useRef(false);
  const name =
    optimistic?.before === project.name ? optimistic.name : project.name;

  useLayoutEffect(() => {
    if (!editing) {
      if (refocus.current) button.current?.focus();
      refocus.current = false;
      return;
    }
    input.current?.focus();
    input.current?.select();
    if (input.current) input.current.scrollLeft = 0;
    entering.current = true;
    const timer = setTimeout(() => (entering.current = false), 250);
    return () => clearTimeout(timer);
  }, [editing]);

  useLayoutEffect(() => {
    setOptimistic(undefined);
  }, [project.name]);

  const finish = (save: boolean, restoreFocus: boolean) => {
    if (submitted.current) return;
    submitted.current = true;
    refocus.current = restoreFocus;
    setEditing(false);
    const next = value.trim();
    if (!save || !next || next === project.name) return;
    setOptimistic({ before: project.name, name: next });
    void onSave({ ...project, name: next }).catch((error) => {
      setOptimistic(undefined);
      onError(error);
    });
  };

  return (
    <nav className="prj-crumbs" aria-label="Breadcrumb">
      {backHref ? (
        <a
          className="prj-crumb-back"
          href={backHref}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onBack();
          }}
        >
          <span>{t("Projects")}</span>
        </a>
      ) : (
        <button type="button" onClick={onBack}>
          {t("Projects")}
        </button>
      )}
      <span aria-hidden="true">/</span>
      {editing ? (
        <div className="prj-crumb-edit">
          <input
            ref={input}
            type="text"
            aria-label={t("Project name")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (isEditEndKey(event, "Enter")) {
                event.preventDefault();
                finish(true, true);
              } else if (isEditEndKey(event, "Escape")) {
                event.preventDefault();
                finish(false, true);
              }
            }}
            onBlur={() => {
              if (entering.current) {
                input.current?.focus();
                input.current?.select();
                return;
              }
              finish(true, false);
            }}
          />
        </div>
      ) : (
        <button
          ref={button}
          type="button"
          className="prj-crumb-name"
          aria-current="page"
          aria-label={formatText("Rename {name}", { name })}
          onClick={() => {
            submitted.current = false;
            setOptimistic(undefined);
            setValue(project.name);
            setEditing(true);
          }}
        >
          <span data-no-translate>{name}</span>
        </button>
      )}
      {children}
    </nav>
  );
}
