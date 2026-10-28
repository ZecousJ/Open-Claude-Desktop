import { Suspense, useEffect, useRef, useState } from "react";
import { Check, X } from "../ui/glyphs";
import {
  checklistRows,
  checklistShowing,
  type HomeChecklistTask,
  type HomeStarters as StarterSettings,
} from "../../shared/home-starters";
import type { Mode } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { formatText, useT } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import StarterPrompts from "./StarterPrompts";
import {
  legacyHomeStartersAllowed,
  homeStarterContextAllowed,
  starterPromptsVisible,
} from "./visibility";
import "./home-starters.css";
import { useExplicitFolderSelection } from "../composer/explicit-folder-selection";
import {
  liveNativeProjectFolder,
  nativeAbsoluteFolder,
} from "../composer/native-place-model";

const MemoryImport = lazyPiece(
  () => import("../memory/MemoryImportDialog"),
  "MemoryImportDialog",
);
const labels: Record<HomeChecklistTask, string> = {
  setup_project: "Set up a project with files and context",
  explore_skills: "Teach Claudex your workflows with skills",
  try_claude_code: "Build, debug, and ship with Claudex Code",
  setup_cowork: "Hand off tasks in Cowork",
  connect_tools: "Connect your everyday tools",
  prosumer_import_memory: "Bring your history over from another AI",
  prosumer_create_file: "Create docs, decks, and sheets",
  prosumer_create_app: "Build an app, no code needed",
  prosumer_explore_imagine: "Visualize anything",
};
const prompts: Partial<Record<HomeChecklistTask, string>> = {
  prosumer_create_file: "Create a spreadsheet, doc, or presentation for me",
  prosumer_create_app: "Create an interactive app that ",
  prosumer_explore_imagine: "Turn this idea into a diagram, chart, or visual: ",
};
const seen = new Set<string>();

// The home checklist and starter chips; persisted preferences decide what
// shows.
type HomeStartersProps = {
  onPick: (prompt: string, submit?: boolean) => void;
  conversationCount: number;
  accountEmail?: string;
  homeShaped?: boolean;
  targetKind?: Mode;
};

export default function HomeStarters(props: HomeStartersProps) {
  const app = useApp();
  const foldersUserTouched = useExplicitFolderSelection(app);
  // A channel project supplies context immediately. A local folder project
  // follows the separately authorized, user-touched folder branch.
  if (
    !homeStarterContextAllowed({
      targetKind: props.targetKind,
      channelProjectSelected: Boolean(
        app.projectId && !liveNativeProjectFolder(app.project),
      ),
      foldersUserTouched,
      folderSelected: nativeAbsoluteFolder(app.cwd),
      folderScopeValid:
        app.host?.kind === "desktop" &&
        app.host.capabilities.localFolders &&
        (!app.project?.environment || app.project.environment.kind === "local"),
    })
  )
    return null;
  return <EligibleHomeStarters {...props} />;
}

function EligibleHomeStarters({
  onPick,
  conversationCount,
  accountEmail,
  homeShaped = false,
  targetKind = "chat",
}: HomeStartersProps) {
  const app = useApp();
  const t = useT();
  const config = app.snapshot.settings.homeStarters ?? {};
  const [memory, setMemory] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const chipsAllowed = legacyHomeStartersAllowed(homeShaped, targetKind);
  const persist = (change: (value: StarterSettings) => StarterSettings) =>
    app.updatePreference({
      homeStarters: change(app.latest.current?.settings.homeStarters ?? config),
    });
  const updateTask = (
    key: HomeChecklistTask,
    patch: { clicked?: boolean; dismissed?: boolean; seen?: number },
  ) =>
    persist((value) => ({
      ...value,
      checklist: {
        ...value.checklist,
        tasks: {
          ...value.checklist?.tasks,
          [key]: { ...value.checklist?.tasks?.[key], ...patch },
        },
      },
    }));
  const showing = checklistShowing(config);
  useEffect(() => {
    const node = panel.current;
    if (!showing || !node || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !entries.some(
            (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5,
          )
        )
          return;
        const fresh = checklistRows(config).filter(
          (key) => !seen.has(`${app.accountId}:${key}`),
        );
        if (!fresh.length) return;
        fresh.forEach((key) => seen.add(`${app.accountId}:${key}`));
        void persist((value) => {
          const tasks = { ...value.checklist?.tasks };
          fresh.forEach((key) => {
            tasks[key] = { ...tasks[key], seen: (tasks[key]?.seen ?? 0) + 1 };
          });
          return { ...value, checklist: { ...value.checklist, tasks } };
        }).catch(app.report);
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [showing, app.accountId, config]);
  const pickTask = async (key: HomeChecklistTask) => {
    await updateTask(key, { clicked: true });
    if (prompts[key]) onPick(t(prompts[key]!));
    else if (key === "setup_project") app.startProject();
    else if (key === "explore_skills") app.setPage("customize");
    else if (key === "try_claude_code") app.newChat("code");
    else if (key === "setup_cowork") app.newChat("cowork");
    else if (key === "connect_tools") app.openSettingsTab("connectors");
    else if (key === "prosumer_import_memory") setMemory(true);
  };
  const blocked = showing && config.prosumer_checklist_hide_prompt_chips;
  const rows = checklistRows(config);
  return (
    <>
      {showing && (
        <div className="home-checklist" ref={panel}>
          <header>
            <h2>{t("Get set up with Claudex")}</h2>
            <span>
              {formatText(t("{completedCount} of {totalCount} completed"), {
                completedCount: rows.filter(
                  (key) => config.checklist?.tasks?.[key]?.clicked,
                ).length,
                totalCount: rows.length,
              })}
            </span>
            <button
              className="checklist-dismiss"
              aria-label={t("Dismiss checklist")}
              onClick={() => {
                void persist((value) => ({
                  ...value,
                  checklist: { ...value.checklist, dismissed: true },
                })).catch(app.report);
              }}
            >
              <X size={16} />
            </button>
          </header>
          {rows.map((key) => (
            <div className="home-checklist-row" key={key}>
              <span
                className="checklist-circle"
                data-complete={
                  config.checklist?.tasks?.[key]?.clicked || undefined
                }
                aria-hidden="true"
              >
                {config.checklist?.tasks?.[key]?.clicked && <Check size={20} />}
              </span>
              <button
                className="checklist-action"
                data-complete={
                  config.checklist?.tasks?.[key]?.clicked || undefined
                }
                onClick={() => {
                  void pickTask(key).catch(app.report);
                }}
              >
                {t(labels[key])}
              </button>
              <button
                className="checklist-dismiss"
                aria-label={t("Dismiss task")}
                onClick={() => {
                  void updateTask(key, { dismissed: true }).catch(app.report);
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {starterPromptsVisible({
        conversationCount,
        hideStarterChips: !chipsAllowed,
        override: config.chipsOverride,
        checklistShowing: showing,
        hideForChecklist: config.prosumer_checklist_hide_prompt_chips,
      }) && <StarterPrompts onPick={(prompt) => onPick(prompt, true)} />}
      {memory && (
        <Suspense fallback={null}>
          <MemoryImport onClose={() => setMemory(false)} />
        </Suspense>
      )}
    </>
  );
}
