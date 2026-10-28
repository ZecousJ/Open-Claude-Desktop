import type { RoutineRepeat } from "../../../shared/routines";
import { securityReviewInstructions } from "../../../shared/security-review";

export type TemplateIcon =
  | "commit"
  | "health"
  | "issues"
  | "pull-request"
  | "dependencies"
  | "flaky"
  | "briefing"
  | "inbox"
  | "calendar"
  | "review"
  | "ideas"
  | "monitor"
  | "security";

export interface RoutineTemplate {
  id: string;
  name: string;
  description: string;
  instructions: string;
  repeat: RoutineRepeat;
  icon: TemplateIcon;
  /** A routine made from it keeps a findings list (shared/security-review.ts). */
  securityReview?: boolean;
}

/**
 * Security review: a weekly review of a folder's branch, run as Code, that
 * keeps what it finds as a list with a status, a recommended fix and an
 * export.
 */
export const securityReviewTemplate: RoutineTemplate = {
  id: "security-review",
  name: "Security review",
  description:
    "Review a branch for vulnerabilities every week and keep the findings, with a recommended fix for each.",
  instructions: securityReviewInstructions,
  repeat: { kind: "weekly", time: "09:00", day: 1 },
  icon: "security",
  securityReview: true,
};

/** Starting points on the Templates tab, then Security review. */
export const routineTemplates: RoutineTemplate[] = [
  {
    id: "briefing",
    name: "Briefing",
    description: "A catch-up on your calendar, email and messages.",
    instructions:
      "Help me catch up. Using the connected tools, put together a short briefing with:\n\n1. Coming up: meetings and events with their times, who is attending and anything I should prepare\n2. Email: unread messages that need me, most urgent first\n3. Messages: direct messages or mentions waiting for a reply\n4. To do: open tasks and follow-ups from the last few days\n\nKeep each item to a line or two, and say plainly if a source had nothing new.",
    repeat: { kind: "weekdays", time: "08:30" },
    icon: "briefing",
  },
  {
    id: "email-triage",
    name: "Email triage",
    description:
      "Sorts your inbox by urgency and drafts replies to what is pressing.",
    instructions:
      "Go through the new and unread email in my inbox with the connected email tool. For each message:\n\n1. Put it in one of: Urgent, Needs action, For information, Can wait\n2. Give its point in one sentence\n3. For Urgent ones, draft a short reply\n\nList the results grouped by category. Draft only: never send, archive or delete anything.",
    repeat: { kind: "weekdays", time: "09:00" },
    icon: "inbox",
  },
  {
    id: "system-health-check",
    name: "System health check",
    description: "Looks for errors, outages and slowdowns in your services.",
    instructions:
      "Check the health of my services through the connected monitoring tools. Report:\n\n1. Incidents: anything ongoing, with its severity and status\n2. Errors: rates that rose since the last check, and where\n3. Performance: noticeably slower responses or heavy resource use\n4. Anything else that looks unusual\n\nStart with a one-line overall status. If everything is fine, say so briefly.",
    repeat: { kind: "daily", time: "09:00" },
    icon: "health",
  },
  {
    id: "issue-triage",
    name: "Issue triage",
    description: "Sorts new issues, bugs and feature requests.",
    instructions:
      "Review the issues opened since the last run in the connected tracker. For each one:\n\n1. Label it as a bug, a feature request, a question or something else\n2. Estimate its priority and say why in a sentence\n3. Point out likely duplicates of existing issues\n4. Note what information is missing, if any\n\nFinish with the issues that need someone's attention first.",
    repeat: { kind: "weekdays", time: "10:00" },
    icon: "issues",
  },
  {
    id: "pr-review-digest",
    name: "PR review digest",
    description:
      "Open pull requests, where their reviews stand and what is stuck.",
    instructions:
      "List the open pull requests in the connected repositories. For each, give the title, author, how long it has been open, its review state and its checks.\n\nThen point out the ones that are blocked, waiting on me, or have had no activity for several days, and suggest what would move each of them forward.",
    repeat: { kind: "weekdays", time: "09:30" },
    icon: "pull-request",
  },
  {
    id: "dependency-update-check",
    name: "Dependency update check",
    description:
      "Outdated packages, security fixes and breaking changes to plan for.",
    instructions:
      "Check this project's dependencies. Report:\n\n1. Security: packages with known vulnerabilities and the version that fixes them\n2. Outdated: packages more than a minor version behind\n3. Breaking changes: major updates available and what they would change\n\nOrder the list by how much each update matters, and suggest which to take first. Do not change any files.",
    repeat: { kind: "weekly", time: "10:00", day: 1 },
    icon: "dependencies",
  },
  {
    id: "flaky-test-tracker",
    name: "Flaky test tracker",
    description: "Finds tests that pass and fail on and off in recent runs.",
    instructions:
      "Look at the recent continuous-integration runs and find tests that both passed and failed on the same code. For each one, give how often it failed, the error it fails with, and a likely cause such as timing, shared state or the network.\n\nRank them by how often they fail, and suggest a fix for the top three.",
    repeat: { kind: "weekly", time: "15:00", day: 1 },
    icon: "flaky",
  },
  securityReviewTemplate,
];

/**
 * The web's Scheduled tasks starting points. The calendar and email ones
 * work through connectors the person has added; the prompts say to use
 * whatever tools are connected.
 */
export const webRoutineTemplates: RoutineTemplate[] = [
  {
    id: "daily-briefing",
    name: "Daily briefing",
    description: "Today's priorities from your calendar, email and messages.",
    instructions:
      "Look across my calendar, email and messages, using whichever tools are connected, and tell me what needs my attention today. List the most important items first and say what I should do about each.",
    repeat: { kind: "weekdays", time: "08:00" },
    icon: "briefing",
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sorts new email and drafts replies to what is urgent.",
    instructions:
      "Go through my inbox with the connected email tool. Sort the new messages into urgent, needs a reply, and can wait, and draft replies to the urgent ones. Do not send anything.",
    repeat: { kind: "weekdays", time: "08:00" },
    icon: "inbox",
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description:
      "A short note for each of today's meetings: who, background and an agenda.",
    instructions:
      "Look at today's meetings on my calendar. For each one, write a short brief: who is attending, what we discussed last time if I have notes or email about it, and a suggested agenda.",
    repeat: { kind: "weekdays", time: "08:00" },
    icon: "calendar",
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "Your week on Friday afternoon: done, open and next.",
    instructions:
      "Summarize my week: what was completed, what is still open, and what should come first next week. Use my calendar, email and any project notes that are connected.",
    repeat: { kind: "weekly", time: "16:00", day: 5 },
    icon: "review",
  },
  {
    id: "content-ideas",
    name: "Content ideas",
    description: "Three post ideas a week, drawn from news in your field.",
    instructions:
      "Search the web for the latest news in my industry and draft three post ideas from it, each with a hook, an angle and a short outline.",
    repeat: { kind: "weekly", time: "09:00", day: 1 },
    icon: "ideas",
  },
  {
    id: "monitor-a-topic",
    name: "Monitor a topic",
    description: "Daily news and mentions of a topic you follow.",
    instructions:
      "Search the web for new news or mentions of the topic, competitor or keyword I care about, and tell me only what is new since the last run. If nothing is new, say so briefly. Ask me for the topic in the first run's notes if it is not written here.",
    repeat: { kind: "daily", time: "09:00" },
    icon: "monitor",
  },
];
