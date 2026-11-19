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
 * Security review: a weekly review of a folder's branch that keeps what it
 * finds as a list with a status, a recommended fix and an export. The
 * original rescans a branch every week the same way (desktop bundle
 * 2.31226.1, Security scans); here the scan is a Code run of the folder.
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

/**
 * Starting points on the Templates tab: the original's desktop set, its
 * words and times (live claude.ai bundle, 2026-10-14, c3fc267c0: Xr),
 * then Security review. Its Release notes drafter starts on a GitHub event,
 * which Claudex's scheduler does not have yet, so it is left out.
 */
export const routineTemplates: RoutineTemplate[] = [
  {
    id: "briefing",
    name: "Briefing",
    description: "Summary of your calendar, emails, and messages.",
    instructions:
      'Generate a briefing to help me catch up. Include:\n\n1. Schedule — List upcoming meetings and events with times, attendees, and any preparation needed\n2. Important emails — Summarize unread emails that need attention, grouped by urgency\n3. Messages requiring response — Flag any direct messages or mentions that need a reply\n4. Action items — List any pending tasks or follow-ups from recent activity\n\nKeep the briefing concise and scannable. If there\'s nothing notable in a section, skip it rather than saying "nothing to report."',
    repeat: { kind: "weekdays", time: "12:18" },
    icon: "briefing",
  },
  {
    id: "email-triage",
    name: "Email triage",
    description:
      "Categorize and prioritize your inbox, with draft responses for urgent items.",
    instructions:
      "Review my inbox for new and unread emails. For each email:\n\n1. Categorize into: Urgent, Action Needed, FYI, or Low Priority\n2. Summarize the key point in one sentence\n3. Draft a response for any emails marked Urgent or Action Needed\n\nPresent results grouped by category, with Urgent items first. For drafted responses, keep the tone professional and concise. If the inbox is empty or all caught up, confirm that briefly.",
    repeat: { kind: "weekdays", time: "14:52" },
    icon: "inbox",
  },
  {
    id: "system-health-check",
    name: "System health check",
    description:
      "Monitor infrastructure and services for errors, outages, and performance issues.",
    instructions:
      'Perform a health check across connected monitoring services. Report:\n\n1. Active incidents — Any ongoing outages or incidents with severity and status\n2. Errors and warnings — New errors or warning patterns since the last check\n3. Performance anomalies — Unusual latency, error rates, or resource usage\n4. Resolved items — Incidents or alerts that were resolved since the last check\n\nPrioritize by severity. For each issue, include the service affected and a direct link if available. If all systems are healthy, confirm with a brief "All systems nominal" message.',
    repeat: { kind: "daily", time: "11:47" },
    icon: "health",
  },
  {
    id: "issue-triage",
    name: "Issue triage",
    description:
      "Review and categorize incoming issues, bugs, and feature requests.",
    instructions:
      "Review new and unassigned issues across connected project trackers. For each issue:\n\n1. Categorize as: Bug, Feature Request, Improvement, or Question\n2. Assess priority based on content: Critical, High, Medium, or Low\n3. Suggest assignment if the issue clearly relates to a specific team or area\n4. Flag duplicates if similar issues already exist\n\nPresent a summary table of all triaged issues, then detailed notes for Critical and High priority items. If there are no new issues, confirm briefly.",
    repeat: { kind: "weekdays", time: "15:23" },
    icon: "issues",
  },
  {
    id: "pr-review-digest",
    name: "PR review digest",
    description:
      "Overview of open PRs, review status, and what needs attention.",
    instructions:
      "Review all open pull requests across the connected repositories. For each PR, report:\n\n1. Title and author\n2. How long it's been open\n3. Review status — approved, changes requested, or awaiting review\n4. CI status — passing, failing, or pending\n5. Merge conflicts — whether the branch is up to date\n\nHighlight any PRs that have been open for more than 3 days or have failing checks. Sort by oldest first. If there are no open PRs, confirm briefly.",
    repeat: { kind: "weekdays", time: "17:49" },
    icon: "pull-request",
  },
  {
    id: "dependency-update-check",
    name: "Dependency update check",
    description:
      "Scan for outdated packages, security patches, and breaking changes.",
    instructions:
      "Check all dependencies in the connected repositories for available updates. For each outdated dependency:\n\n1. Current version vs latest version\n2. Update type — major, minor, or patch\n3. Breaking changes noted in changelogs\n4. Security advisories — any known CVEs or vulnerabilities\n\nPrioritize security-related updates. Group results by repository and severity. If everything is up to date, confirm briefly.",
    repeat: { kind: "weekly", time: "18:16", day: 1 },
    icon: "dependencies",
  },
  {
    id: "flaky-test-tracker",
    name: "Flaky test tracker",
    description:
      "Find tests that pass and fail intermittently across recent CI runs.",
    instructions:
      "Identify flaky tests — tests that both passed and failed on the same code over the past week.\n\n1. Pull CI workflow runs from the last 7 days on the default branch. Focus on test jobs.\n2. For each test failure, note the test name, file, and the commit it ran against. A test is flaky if it failed on a commit where the same test also passed (in a retry, a re-run, or a later run on the same SHA).\n3. Rank flaky tests by flake rate (failures ÷ total runs) and total time wasted on retries.\n4. For the top 5, include: test name and file path, flake rate, a link to one failing and one passing run on the same commit, and the failure message pattern if it's consistent.\n5. Note any tests that are newly flaky this week vs. ones that appeared in last week's report.\n6. For the #1 flakiest test, attempt a fix: read the test and the code it exercises, identify the likely cause (race condition, unawaited promise, time/order dependence, shared state, network reliance), apply a targeted fix, verify it passes locally across several runs, and open a pull request titled \"fix(flaky): <test name>\" with the root-cause analysis in the description. If you can't determine a safe fix, open a draft PR that quarantines the test (skip with a comment linking this report) instead.\n\nPresent as a ranked table followed by per-test detail, then a link to the fix PR. If no flaky tests are found, confirm that briefly along with the total number of test runs scanned.",
    repeat: { kind: "weekly", time: "15:54", day: 1 },
    icon: "flaky",
  },
  securityReviewTemplate,
];

/**
 * The web's Scheduled tasks starting points (live claude.ai, 2026-09-29):
 * names, descriptions and schedules as the page shows them. The calendar
 * and email ones work through connectors the person has added; the prompts
 * say to use whatever tools are connected.
 */
export const webRoutineTemplates: RoutineTemplate[] = [
  {
    id: "daily-briefing",
    name: "Daily briefing",
    description:
      "What needs your attention today across calendar, email, and messages.",
    instructions:
      "Look across my calendar, email and messages, using whichever tools are connected, and tell me what needs my attention today. List the most important items first and say what I should do about each.",
    repeat: { kind: "weekdays", time: "08:00" },
    icon: "briefing",
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Categorize your inbox and draft replies to anything urgent.",
    instructions:
      "Go through my inbox with the connected email tool. Sort the new messages into urgent, needs a reply, and can wait, and draft replies to the urgent ones. Do not send anything.",
    repeat: { kind: "weekdays", time: "08:00" },
    icon: "inbox",
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description:
      "A short brief before each meeting on your calendar, covering attendees, context, and agenda.",
    instructions:
      "Look at today's meetings on my calendar. For each one, write a short brief: who is attending, what we discussed last time if I have notes or email about it, and a suggested agenda.",
    repeat: { kind: "weekdays", time: "08:00" },
    icon: "calendar",
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "A Friday summary of what happened this week.",
    instructions:
      "Summarize my week: what was completed, what is still open, and what should come first next week. Use my calendar, email and any project notes that are connected.",
    repeat: { kind: "weekly", time: "16:00", day: 5 },
    icon: "review",
  },
  {
    id: "content-ideas",
    name: "Content ideas",
    description:
      "Draft a few post ideas each week from the latest news in your industry.",
    instructions:
      "Search the web for the latest news in my industry and draft three post ideas from it, each with a hook, an angle and a short outline.",
    repeat: { kind: "weekly", time: "09:00", day: 1 },
    icon: "ideas",
  },
  {
    id: "monitor-a-topic",
    name: "Monitor a topic",
    description:
      "Watch for news or mentions of a topic, competitor, or keyword.",
    instructions:
      "Search the web for new news or mentions of the topic, competitor or keyword I care about, and tell me only what is new since the last run. If nothing is new, say so briefly. Ask me for the topic in the first run's notes if it is not written here.",
    repeat: { kind: "daily", time: "09:00" },
    icon: "monitor",
  },
];
