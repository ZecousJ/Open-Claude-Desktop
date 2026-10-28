import { type ReactNode } from "react";
import { useRef, useState, type ComponentType } from "react";
import { type LucideProps } from "lucide-react";
import {
  ArrowRight,
  Binoculars,
  BookOpen,
  Calendar,
  ChartLine,
  Code,
  Dna,
  Files,
  Gavel,
  Globe,
  GraduationCap,
  LayoutGrid,
  Lightbulb,
  MessagesSquare,
  Monitor,
  Palette,
  Pencil,
  Presentation,
  User,
  Check,
  ChevronDown,
  Clock,
} from "../ui/glyphs";
import { currentLocale, t } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { useHost } from "../host/HostContext";
import {
  type CodeSetup,
  scienceFields,
  type ScienceField,
} from "../../shared/onboarding-api";
import { workTypes, type WorkType } from "../../shared/settings-extras";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { type FirstTask, type FirstTaskIcon } from "./first-tasks";
import "./onboarding.css";

/** "What kind of work do you do?": one role, then Continue. */
export function WorkStep({
  value,
  onChange,
  onContinue,
  science,
  onScienceChange,
}: {
  value?: WorkType;
  onChange: (value: WorkType) => void;
  onContinue: (value: WorkType) => void;
  science: ScienceField[];
  onScienceChange: (fields: ScienceField[]) => void;
}) {
  return (
    <StepPage
      title="What kind of work do you do?"
      subtitle="Pick a role so Claudex can tailor your experience."
      cta={
        <button
          type="button"
          className="primary onboarding-wide"
          disabled={!value}
          onClick={() => value && onContinue(value)}
        >
          Continue
        </button>
      }
    >
      <RoleSelect value={value} onChange={onChange} />
      {value === "Scientist" && (
        <ScienceFieldsSelect value={science} onChange={onScienceChange} />
      )}
    </StepPage>
  );
}

/**
 * The role field: a button that opens a menu of the roles, the same pattern as
 * the science field below.
 */
function RoleSelect({
  value,
  onChange,
}: {
  value?: WorkType;
  onChange: (value: WorkType) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const picked = workTypes.find((option) => option.value === value);
  const label = t("Search for your role");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="onboarding-select onboarding-science-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        data-empty={!picked || undefined}
        onClick={() => {
          if (menu) return setMenu(undefined);
          const box = trigger.current!.getBoundingClientRect();
          setMenu({ left: box.left, top: box.bottom + 4 });
        }}
      >
        <span>{picked ? t(picked.label) : label}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {menu && (
        <Menu
          label={label}
          entries={workTypes.map((option) => ({
            label: option.label,
            checked: option.value === value,
            checkedRole: "radio" as const,
            onSelect: () => onChange(option.value),
          }))}
          position={menu}
          width={trigger.current?.getBoundingClientRect().width ?? 320}
          size="regular"
          anchors={[trigger]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

/**
 * "What kind of science do you do? (optional)" under the Scientist role: a
 * multiple select with the field label above, "Select all that apply" until
 * something is picked, then the picks as a list.
 */
function ScienceFieldsSelect({
  value,
  onChange,
}: {
  value: ScienceField[];
  onChange: (fields: ScienceField[]) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const picked = scienceFields.filter((field) => value.includes(field.value));
  const label = t("What kind of science do you do? (optional)");
  return (
    <div className="onboarding-science">
      <label className="onboarding-science-label" id="onboarding-science">
        {label}
      </label>
      <button
        ref={trigger}
        type="button"
        className="onboarding-select onboarding-science-trigger"
        aria-labelledby="onboarding-science"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        data-empty={picked.length === 0 || undefined}
        onClick={() => {
          if (menu) return setMenu(undefined);
          const box = trigger.current!.getBoundingClientRect();
          setMenu({ left: box.left, top: box.bottom + 4 });
        }}
      >
        <span>
          {picked.length
            ? new Intl.ListFormat(currentLocale(), { type: "unit" }).format(
                picked.map((field) => t(field.label)),
              )
            : t("Select all that apply")}
        </span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {menu && (
        <Menu
          label={label}
          entries={scienceFields.map((field) => ({
            label: field.label,
            checked: value.includes(field.value),
            checkedRole: "checkbox" as const,
            keepOpen: true,
            onSelect: () =>
              onChange(
                scienceFields
                  .map((option) => option.value)
                  .filter((option) =>
                    option === field.value
                      ? !value.includes(option)
                      : value.includes(option),
                  ),
              ),
          }))}
          position={menu}
          width={trigger.current?.getBoundingClientRect().width ?? 320}
          size="regular"
          anchors={[trigger]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

/**
 * "Set up and start coding": the place to code, then Continue for those not
 * interested. Claudex has Code built in, so there is no install command: a tile
 * opens Code here (on the desktop, or on the web) once the onboarding ends.
 */
export function CodeStep({
  onPick,
  onSkip,
}: {
  onPick: (place: CodeSetup) => void;
  onSkip: () => void;
}) {
  const web = useHost().kind === "web";
  const place: CodeSetup = web ? "web" : "desktop";
  const Icon = web ? Globe : Monitor;
  return (
    <StepPage
      title="Set up and start coding"
      subtitle="Pick where you want to start."
      cta={
        <div className="onboarding-code-cta">
          <span className="onboarding-code-question">
            Not interested in coding?
          </span>
          <span className="onboarding-code-note">
            Continue to chat with Claudex. You can come back to Code whenever
            you like.
          </span>
          <button
            type="button"
            className="secondary onboarding-arrow"
            onClick={onSkip}
          >
            Continue
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      }
    >
      <div className="onboarding-card onboarding-code-card">
        <div className="onboarding-tiles">
          <button
            type="button"
            className="onboarding-tile"
            onClick={() => onPick(place)}
          >
            <Icon size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>{web ? "Web" : "Desktop"}</span>
          </button>
        </div>
      </div>
    </StepPage>
  );
}

export const connected = (server: McpServerState) =>
  server.state === "ready" && server.authStatus !== "notLoggedIn";

export function Chip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="onboarding-chip"
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="onboarding-chip-mark" aria-hidden="true">
        {pressed && <Check size={12} strokeWidth={2.5} />}
      </span>
      {label}
    </button>
  );
}

const taskIcons: Record<FirstTaskIcon, ComponentType<LucideProps>> = {
  binoculars: Binoculars,
  books: BookOpen,
  calendarBlank: Calendar,
  chartLine: ChartLine,
  chatsCircle: MessagesSquare,
  clock: Clock,
  code: Code,
  dna: Dna,
  files: Files,
  gavel: Gavel,
  graduationCap: GraduationCap,
  lightbulb: Lightbulb,
  palette: Palette,
  pencil: Pencil,
  person: User,
  presentation: Presentation,
  squaresFour: LayoutGrid,
};

/**
 * The first task: three ideas for the chosen work, and "I have my own topic". A
 * pick ends the onboarding with its prompt in the composer of a new task, ready
 * to send.
 */
export function FirstTaskStep({
  tasks,
  busy,
  onPick,
  onOwnTopic,
}: {
  tasks: FirstTask[];
  busy: boolean;
  onPick: (task: FirstTask) => void;
  onOwnTopic: () => void;
}) {
  return (
    <StepPage
      title="What would you like to try first?"
      subtitle="Some starter ideas based on your interests."
    >
      <ul
        className="onboarding-tasks"
        aria-label={t("Starter prompt suggestions")}
      >
        {tasks.map((task) => {
          const Icon = taskIcons[task.icon];
          return (
            <li key={task.id}>
              <button
                type="button"
                className="onboarding-task"
                disabled={busy}
                onClick={() => onPick(task)}
              >
                <span className="onboarding-task-icon" aria-hidden="true">
                  <Icon size={24} strokeWidth={1.5} />
                </span>
                {task.title}
              </button>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            className="onboarding-task onboarding-own"
            disabled={busy}
            onClick={onOwnTopic}
          >
            <span className="onboarding-task-icon" aria-hidden="true">
              <ArrowRight size={20} strokeWidth={1.75} />
            </span>
            I have my own topic
          </button>
        </li>
      </ul>
    </StepPage>
  );
}

/** A step's heading, subtitle, body and call to action (`F`, contentWidth sm). */
export function StepPage({
  title,
  subtitle,
  children,
  cta,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <div className="onboarding-step">
      <header className="onboarding-head">
        <h1 tabIndex={-1}>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </header>
      {children && <div className="onboarding-body">{children}</div>}
      {cta && <div className="onboarding-cta">{cta}</div>}
    </div>
  );
}
