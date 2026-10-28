import { useEffect, useState } from "react";
import type { Conversation, Project, Approval } from "../../shared/types";
import {
  sessionPullRequest,
  type PullRequestRef,
} from "../../shared/pull-request";
import { formatText, t } from "../i18n";
import { relativeTime } from "../ui/RelativeTime";
import { isRunning } from "../conversation/unread";
import "./code-landing.css";

export type AttentionKind = "blocked" | "review" | "unread" | "working";

const kindLabels: Record<AttentionKind, string> = {
  blocked: "Needs input",
  review: "Ready for review",
  unread: "Unread",
  working: "Working",
};

/**
 * A session's place on the landing: left out when archived, pinned or
 * incognito; blocked while it waits on the person; ready for review when its
 * pull request is new to them; unread; working while it runs.
 */
export function attentionKind(
  c: Conversation,
  approvals: readonly Pick<Approval, "conversationId">[],
): AttentionKind | undefined {
  if (c.mode !== "code" || c.archived || c.pinned || c.incognito)
    return undefined;
  if (approvals.some((a) => a.conversationId === c.id)) return "blocked";
  if (c.turns.at(-1)?.status === "failed") return "blocked";
  if (isRunning(c)) return "working";
  if (c.sessionState === "blocked") return "blocked";
  if (c.sessionState === "ready_for_review") return "review";
  if (c.unread) return sessionPullRequest(c) ? "review" : "unread";
  return undefined;
}

/** The sessions, blocked first, then the rest, each newest first. */
export function attentionSessions(
  conversations: readonly Conversation[],
  approvals: readonly Pick<Approval, "conversationId">[],
) {
  const rows = conversations.flatMap((c) => {
    const kind = attentionKind(c, approvals);
    return kind ? [{ conversation: c, kind }] : [];
  });
  const newest = (
    a: { conversation: Conversation },
    b: { conversation: Conversation },
  ) => b.conversation.updatedAt - a.conversation.updatedAt;
  return [
    ...rows.filter((row) => row.kind === "blocked").sort(newest),
    ...rows.filter((row) => row.kind !== "blocked").sort(newest),
  ];
}

const weekMs = 6048e5;

/**
 * Projects with something going on: an unread or running session, or activity
 * in the last 7 days; unread first, then running, then recent, newest first,
 * then by name.
 */
export function landingProjects(
  projects: readonly Project[],
  conversations: readonly Conversation[],
  now = Date.now(),
) {
  return projects
    .flatMap((project) => {
      const sessions = conversations.filter(
        (c) =>
          c.projectId === project.id &&
          c.mode === "code" &&
          !c.archived &&
          !c.incognito,
      );
      if (!sessions.length) return [];
      const last = Math.max(...sessions.map((c) => c.updatedAt));
      const unread = sessions.some((c) => c.unread);
      const running = sessions.some(isRunning);
      if (!unread && !running && now - last > weekMs) return [];
      return [{ project, sessions, last, tier: unread ? 0 : running ? 1 : 2 }];
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.last - a.last ||
        a.project.name.localeCompare(b.project.name),
    );
}

/** The rows a section shows before Show N more: 3 to 5 by the window's height. */
export function landingRowLimit(height: number, cap = 5) {
  const rows = 3 + [800, 900, 1000, 1100].filter((min) => height >= min).length;
  return Math.min(rows, cap);
}

function useWindowHeight() {
  const [height, setHeight] = useState(() =>
    typeof window === "undefined" ? 800 : window.innerHeight,
  );
  useEffect(() => {
    const resize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return height;
}

function Pill({ kind }: { kind: AttentionKind }) {
  return (
    <span className="landing-pill" data-kind={kind}>
      <span className="landing-dot-slot">
        <span className="landing-dot" />
      </span>
      <span className="landing-pill-label">{t(kindLabels[kind])}</span>
    </span>
  );
}

function Section({
  title,
  total,
  limit,
  extra,
  children,
}: {
  title: string;
  total: number;
  limit: number;
  extra?: React.ReactNode;
  children: (shown: number) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? total : Math.min(total, limit);
  const more = total - Math.min(total, limit);
  return (
    <section className="landing-section">
      <header>
        <h2>{t(title)}</h2>
        <span className="landing-spring" />
        {extra}
        {more > 0 && (
          <button
            type="button"
            className="landing-more"
            onClick={() => setAll(!all)}
          >
            {all
              ? t("Show less")
              : formatText("Show {count} more", { count: more })}
          </button>
        )}
      </header>
      <ul role="list">{children(shown)}</ul>
    </section>
  );
}

/**
 * The Code landing's sections under the composer: Sessions that need the person
 * (Needs input, Ready for review, Unread, Working) with Mark all as read,
 * Projects with something going on, and the sessions' Pull requests; each shows
 * 3 to 5 rows by the window's height, then Show {count} more. A section with
 * nothing in it is left out.
 */
export function CodeLanding({
  conversations,
  projects,
  approvals,
  onOpen,
  onOpenProject,
  onOpenPr,
  onMarkAllRead,
}: {
  conversations: Conversation[];
  projects: Project[];
  approvals: readonly Pick<Approval, "conversationId">[];
  onOpen: (conversation: Conversation) => void;
  onOpenProject: (project: Project) => void;
  onOpenPr: (pr: PullRequestRef) => void;
  onMarkAllRead?: () => void;
}) {
  const height = useWindowHeight();
  const limit = landingRowLimit(height);
  const prLimit = landingRowLimit(height, Number.POSITIVE_INFINITY);
  const sessions = attentionSessions(conversations, approvals);
  const busyProjects = landingProjects(projects, conversations);
  const pulls = conversations
    .filter((c) => c.mode === "code" && !c.archived && !c.incognito)
    .flatMap((c) => {
      const pr = sessionPullRequest(c);
      return pr ? [{ conversation: c, pr }] : [];
    })
    .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt);
  if (!sessions.length && !busyProjects.length && !pulls.length) return null;
  const unread = sessions.some(
    (row) => row.kind === "unread" || row.kind === "review",
  );
  return (
    <div className="code-landing">
      {sessions.length > 0 && (
        <Section
          title="Sessions"
          total={sessions.length}
          limit={limit}
          extra={
            unread && onMarkAllRead ? (
              <button
                type="button"
                className="landing-more"
                onClick={onMarkAllRead}
              >
                {t("Mark all as read")}
              </button>
            ) : undefined
          }
        >
          {(shown) =>
            sessions.slice(0, shown).map(({ conversation: c, kind }) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="landing-row"
                  aria-label={formatText("Open session {title}", {
                    title: c.title,
                  })}
                  onClick={() => onOpen(c)}
                >
                  <Pill kind={kind} />
                  <span className="landing-title" data-no-translate>
                    {c.title || t("Untitled session")}
                  </span>
                  <span className="landing-time">
                    {relativeTime(c.updatedAt)}
                  </span>
                </button>
              </li>
            ))
          }
        </Section>
      )}
      {busyProjects.length > 0 && (
        <Section title="Projects" total={busyProjects.length} limit={limit}>
          {(shown) =>
            busyProjects
              .slice(0, shown)
              .map(({ project, sessions: inside, last }) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className="landing-row"
                    onClick={() => onOpenProject(project)}
                  >
                    <span className="landing-title" data-no-translate>
                      {project.name}
                    </span>
                    <span className="landing-meta">
                      {inside.length === 1
                        ? t("1 session")
                        : formatText("{count} sessions", {
                            count: inside.length,
                          })}
                    </span>
                    <span className="landing-time">{relativeTime(last)}</span>
                  </button>
                </li>
              ))
          }
        </Section>
      )}
      {pulls.length > 0 && (
        <Section title="Pull requests" total={pulls.length} limit={prLimit}>
          {(shown) =>
            pulls.slice(0, shown).map(({ conversation: c, pr }) => (
              <li key={`${c.id}:${pr.url}`}>
                <button
                  type="button"
                  className="landing-row"
                  onClick={() => onOpenPr(pr)}
                >
                  <span className="landing-title" data-no-translate>
                    {c.title || t("Untitled session")}
                  </span>
                  <span className="landing-meta" data-no-translate>
                    {pr.repository} #{pr.number}
                  </span>
                  <span className="landing-time">
                    {relativeTime(c.updatedAt)}
                  </span>
                </button>
              </li>
            ))
          }
        </Section>
      )}
    </div>
  );
}
