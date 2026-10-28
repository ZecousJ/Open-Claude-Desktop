import { tc, useLocale } from "../../i18n";
import { Suspense, useEffect, useState } from "react";
import { Power } from "lucide-react";
import { FileText, FolderOpen, Plus, Trash2 } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import type {
  CustomizeSkill,
  SkillContents,
} from "../../../shared/collections-api";
import { Modal } from "../../ui/Controls";
import { Markdown } from "../../ui/Markdown";
import type { StarterSkill } from "./starter-skills";
import type { SkillDetailView } from "./InstalledSkillPage";
import { lazyPiece } from "../../ui/lazy-piece";
import "./skill-detail.css";

const InstalledSkillPage = lazyPiece(
  () => import("./InstalledSkillPage"),
  "InstalledSkillPage",
);

const scopeLabels: Record<CustomizeSkill["scope"], string> = {
  user: "Added by you",
  repo: "From the open project",
  system: "Built in",
  admin: "From your organization",
};

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

/**
 * A skill's details. A starter from Discover shows its instructions and Add; an
 * installed skill shows its SKILL.md rendered, the files in its folder, where
 * it comes from, and Turn on/off, Show in folder and (for the person's own
 * skills) Remove.
 */
export function SkillDetail({
  skill,
  added,
  busy,
  onClose,
  onAdd,
  onTry,
  onToggle,
  onReveal,
  onRemove,
  onDuplicate,
  page,
}: {
  skill: StarterSkill | CustomizeSkill;
  added: boolean;
  busy: boolean;
  onClose: () => void;
  onAdd: () => Promise<void>;
  onTry: () => void;
  /** Installed skills: turns the skill on or off. */
  onToggle: (skill: CustomizeSkill) => Promise<void>;
  /** Show in folder; absent where the skill's folder is not on this computer. */
  onReveal?: (skill: CustomizeSkill) => void;
  /** The person's own skills: asks, then removes. */
  onRemove: (skill: CustomizeSkill) => void;
  onDuplicate?: (skill: CustomizeSkill) => void;
  page?: {
    view: SkillDetailView;
    onViewChange: (view: SkillDetailView) => void;
    links: { back: string; overview: string; contents: string };
  };
}) {
  const starter = "instructions" in skill;
  const installed = starter ? undefined : (skill as CustomizeSkill);
  useLocale();
  const [loaded, setLoaded] = useState<{
    path: string;
    contents: SkillContents | null;
    error?: string;
  }>();
  const contents =
    loaded?.path === installed?.path ? loaded?.contents : undefined;
  const error = loaded?.path === installed?.path ? (loaded?.error ?? "") : "";
  const [switching, setSwitching] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!installed) return;
    let live = true;
    window.desktop
      .readSkill(installed.path)
      .then((value) => {
        if (
          !value ||
          typeof value.markdown !== "string" ||
          !Array.isArray(value.files) ||
          !value.files.every(
            (file) =>
              file &&
              typeof file.path === "string" &&
              typeof file.bytes === "number",
          ) ||
          typeof value.truncated !== "boolean"
        )
          throw new Error("Couldn’t load skill contents.");
        if (live) setLoaded({ path: installed.path, contents: value });
      })
      .catch((reason) => {
        if (!live) return;
        setLoaded({
          path: installed.path,
          contents: null,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      live = false;
    };
  }, [installed?.path, reload]);
  if (installed && page)
    return (
      <Suspense fallback={null}>
        <InstalledSkillPage
          key={installed.path}
          skill={installed}
          contents={contents}
          error={error}
          onReload={() => {
            setLoaded(undefined);
            setReload((value) => value + 1);
          }}
          view={page.view}
          onViewChange={page.onViewChange}
          links={page.links}
          onBack={onClose}
          onTry={onTry}
          onToggle={() => onToggle(installed)}
          onReveal={onReveal ? () => onReveal(installed) : undefined}
          onRemove={() => onRemove(installed)}
          onDuplicate={onDuplicate ? () => onDuplicate(installed) : undefined}
        />
      </Suspense>
    );
  return (
    <Modal
      title={starter ? skill.title : skill.name}
      titleIsUserData={!starter}
      onClose={onClose}
      wide
    >
      <div className="customize-detail skill-detail">
        <p data-no-translate={installed ? true : undefined}>
          {skill.description}
        </p>
        {starter && <pre>{skill.instructions}</pre>}
        {installed && (
          <>
            <dl className="skill-detail-facts">
              <div>
                <dt>Source</dt>
                <dd>{scopeLabels[installed.scope]}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{tc("state", installed.enabled ? "On" : "Off")}</dd>
              </div>
            </dl>
            {contents === undefined ? (
              <div className="skill-detail-loading" aria-label="Loading skill">
                <Spinner inheritColor size={16} className="spin" />
              </div>
            ) : contents === null ? (
              <p className="customize-error" role="alert">
                {error}
              </p>
            ) : (
              <>
                <h3 className="skill-detail-label">SKILL.md</h3>
                <div className="skill-detail-markdown" data-no-translate>
                  {contents.markdown ? (
                    <Markdown text={contents.markdown} />
                  ) : (
                    <p>This skill has no instructions.</p>
                  )}
                </div>
                <h3 className="skill-detail-label">
                  Files <span>{contents.files.length}</span>
                </h3>
                <ul className="skill-detail-files">
                  {contents.files.map((file) => (
                    <li key={file.path}>
                      <FileText
                        size={13}
                        strokeWidth={1.6}
                        aria-hidden="true"
                      />
                      <span title={file.path} data-no-translate>
                        {file.path}
                      </span>
                      <small>{size(file.bytes)}</small>
                    </li>
                  ))}
                  {contents.truncated && (
                    <li className="skill-detail-more">
                      More files are in the skill’s folder.
                    </li>
                  )}
                </ul>
              </>
            )}
          </>
        )}
        <div className="button-row skill-detail-actions">
          {installed && (
            <>
              {installed.own && (
                <button
                  type="button"
                  className="secondary skill-detail-remove"
                  onClick={() => onRemove(installed)}
                >
                  <Trash2 size={14} /> Remove
                </button>
              )}
              {onReveal && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onReveal(installed)}
                >
                  <FolderOpen size={14} /> Show in folder
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={switching}
                onClick={() => {
                  setSwitching(true);
                  void onToggle(installed).finally(() => setSwitching(false));
                }}
              >
                <Power size={14} /> {installed.enabled ? "Turn off" : "Turn on"}
              </button>
            </>
          )}
          {starter && !added ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void onAdd()}
            >
              <Plus size={15} /> Add
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={Boolean(installed && !installed.enabled)}
              onClick={onTry}
            >
              Try in chat
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
