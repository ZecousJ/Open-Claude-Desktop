/**
 * The onboarding's first task: starter tasks for each work type. The original
 * keeps five per role and shows three picked at random; Claudex keeps the first
 * three of each and shows them in that order.
 */
import type { WorkType } from "../../shared/settings-extras";

export type FirstTaskIcon =
  | "binoculars"
  | "books"
  | "calendarBlank"
  | "chartLine"
  | "chatsCircle"
  | "clock"
  | "code"
  | "dna"
  | "files"
  | "gavel"
  | "graduationCap"
  | "lightbulb"
  | "palette"
  | "pencil"
  | "person"
  | "presentation"
  | "squaresFour";

export interface FirstTask {
  id: string;
  icon: FirstTaskIcon;
  /** The line the list shows. */
  title: string;
  /** What the composer receives. */
  prompt: string;
}

export const firstTasks: Record<WorkType, FirstTask[]> = {
  "Product Management": [
    {
      id: "pm_prd",
      icon: "files",
      title: "Build a PRD template",
      prompt:
        "Create a one-page PRD outline template with sections for problem statement, goals, scope, and success metrics",
    },
    {
      id: "pm_backlog",
      icon: "squaresFour",
      title: "Prep a stakeholder update",
      prompt:
        "Help me prep a stakeholder update — what to lead with and what questions to expect.",
    },
    {
      id: "pm_ac",
      icon: "pencil",
      title: "Prioritize my backlog",
      prompt:
        "Give me a framework for prioritizing backlog items by impact and effort, and show me how to spot the easy wins. I’ll paste my items next.",
    },
  ],
  Engineering: [
    {
      id: "eng_spec",
      icon: "files",
      title: "Debug unexpected behavior",
      prompt:
        "I’m seeing unexpected behavior or errors in a system. Help me work through it systematically — I’ll share details on what’s happening.",
    },
    {
      id: "eng_troubleshoot",
      icon: "lightbulb",
      title: "Evaluate architecture tradeoffs",
      prompt:
        "Help me compare engineering design options. I’ll describe two approaches; weigh the tradeoffs and tell me which you’d pick and why.",
    },
    {
      id: "eng_calc",
      icon: "chartLine",
      title: "Plan an eng project",
      prompt:
        "Help me scope an engineering project: phases, dependencies, and risks.",
    },
  ],
  "Human Resources": [
    {
      id: "hr_jd",
      icon: "person",
      title: "Draft a job description",
      prompt:
        "Draft a job description — I’ll share the role title and key details.",
    },
    {
      id: "hr_interview",
      icon: "chatsCircle",
      title: "Interview questions from JD",
      prompt:
        "Draft behavioral and role-specific interview questions. I’ll paste the job description below.",
    },
    {
      id: "hr_onboarding",
      icon: "calendarBlank",
      title: "Plan an onboarding checklist",
      prompt:
        "Help me build a 30-day onboarding checklist for a new hire on my team.",
    },
  ],
  Finance: [
    {
      id: "fin_forecast",
      icon: "chartLine",
      title: "Explain a finance concept",
      prompt:
        "Give me a quick-hit explanation of one tricky finance concept — like DCF, accrual accounting, or working capital — with a concrete example.",
    },
    {
      id: "fin_variance",
      icon: "chartLine",
      title: "Draft a board memo",
      prompt:
        "Draft a one-page board memo for quarterly financial results. I’ll share the headline numbers — structure the narrative around them.",
    },
    {
      id: "fin_memo",
      icon: "files",
      title: "Frame a budget variance",
      prompt:
        "Give me a leadership-ready explanation framework for a budget-to-actual variance.",
    },
  ],
  Marketing: [
    {
      id: "mkt_copy",
      icon: "pencil",
      title: "Plan a campaign calendar",
      prompt:
        "Help me plan a campaign calendar for the next quarter — channels, cadence, milestones.",
    },
    {
      id: "mkt_launch",
      icon: "presentation",
      title: "Explain attribution models",
      prompt:
        "Walk me through the main marketing attribution models — first-touch, last-touch, linear, time-decay — and when each one makes sense.",
    },
    {
      id: "mkt_lp",
      icon: "pencil",
      title: "Campaign copy variants",
      prompt:
        "Give me three copy variants for a campaign — I’ll paste my brief and CTA below. Try different angles (urgency, aspiration, social proof).",
    },
  ],
  Sales: [
    {
      id: "sal_outreach",
      icon: "pencil",
      title: "Prep for a discovery call",
      prompt:
        "Help me prep for a discovery call — questions to ask and traps to avoid.",
    },
    {
      id: "sal_discovery",
      icon: "chatsCircle",
      title: "Draft a cold outreach email",
      prompt:
        "Draft a cold outreach email for me. If I haven’t shared them, ask for: who I’m targeting, what I’m selling, and the hook. Then write a short, specific email.",
    },
    {
      id: "sal_objection",
      icon: "lightbulb",
      title: "Handle a sales objection",
      prompt:
        "Help me respond to a sales objection without sounding defensive — I’ll share what the prospect said.",
    },
  ],
  Operations: [
    {
      id: "ops_map",
      icon: "squaresFour",
      title: "Plan a rollout",
      prompt:
        "Help me plan the rollout of a process change — sequencing, owners, comms.",
    },
    {
      id: "ops_sop",
      icon: "files",
      title: "Draft an SOP",
      prompt:
        "Draft a standard operating procedure for a process I’ll describe (e.g., onboarding a vendor) — steps, owners, and checkpoints.",
    },
    {
      id: "ops_bottlenecks",
      icon: "clock",
      title: "Draft a vendor RFP",
      prompt:
        "Create an RFP template I can fill in for a vendor. Include sections for scope, requirements, evaluation criteria, and timeline.",
    },
  ],
  "Data Science": [
    {
      id: "ds_explore",
      icon: "chartLine",
      title: "Boost model performance",
      prompt:
        "Walk me through a framework for diagnosing and improving ML model performance.",
    },
    {
      id: "ds_model",
      icon: "code",
      title: "Explore my dataset",
      prompt:
        "I’ll paste my dataset (or describe its columns) below — then help me figure out what to look at first and which plots to start with.",
    },
    {
      id: "ds_eval",
      icon: "chartLine",
      title: "Read my eval metrics",
      prompt:
        "I’ll paste my evaluation results below. Help me interpret what the metrics mean and suggest what to try next.",
    },
  ],
  Design: [
    {
      id: "des_crit",
      icon: "palette",
      title: "Explore visual directions",
      prompt:
        "Help me brainstorm visual directions for a brand or feature — moodboard feel, color palette, and typography.",
    },
    {
      id: "des_directions",
      icon: "palette",
      title: "Plan a usability test",
      prompt:
        "Help me plan a quick usability test — tasks, what to watch for, how many participants.",
    },
    {
      id: "des_microcopy",
      icon: "pencil",
      title: "Critique my mockup",
      prompt:
        "Critique the UI mockup I’m about to share — flag issues with hierarchy, spacing, and anything that reads as confusing.",
    },
  ],
  Legal: [
    {
      id: "leg_summarize",
      icon: "gavel",
      title: "Flag contract risks",
      prompt:
        "I’ll paste a contract below. Flag the clauses that carry the most risk for my side and briefly explain why each matters.",
    },
    {
      id: "leg_clause",
      icon: "gavel",
      title: "Draft contract clause",
      prompt:
        "Draft a contract clause (e.g. indemnity, NDA, limitation of liability) in plain language.",
    },
    {
      id: "leg_compare",
      icon: "files",
      title: "Summarize a contract",
      prompt:
        "Summarize the contract I’ll paste below — key obligations, deadlines, and any red flags or unusual clauses.",
    },
  ],
  Scientist: [
    {
      id: "sci_design",
      icon: "dna",
      title: "Interpret my results",
      prompt:
        "I’ll paste my results below. Help me interpret what they show, what they don’t show, and how to frame them accurately.",
    },
    {
      id: "sci_methods",
      icon: "files",
      title: "Design an experiment",
      prompt:
        "Help me design a controlled experiment to test a hypothesis — I’ll describe it next. Include controls, variables, and methodology.",
    },
    {
      id: "sci_interpret",
      icon: "lightbulb",
      title: "Abstract from notes",
      prompt:
        "Draft a structured scientific abstract from my bullet points. I’ll paste my key findings, methods, and conclusions — you handle the framing.",
    },
  ],
  Student: [
    {
      id: "stu_explain",
      icon: "graduationCap",
      title: "Make a study plan",
      prompt:
        "Help me make a study plan for an exam — what to cover each day and how to test myself.",
    },
    {
      id: "stu_quiz",
      icon: "books",
      title: "Break down a concept",
      prompt:
        "Pick a concept I’m likely struggling with and explain it like it’s my first time",
    },
    {
      id: "stu_essay",
      icon: "pencil",
      title: "Outline my essay",
      prompt:
        "Help me outline an essay — thesis, body sections, and what each should cover. I’ll paste my essay prompt or topic next.",
    },
  ],
  Founder: [
    {
      id: "fnd_update",
      icon: "pencil",
      title: "Map the competitive landscape",
      prompt:
        "I’ll describe what I’m building in one line. Map the competitive landscape: key players, how they’re positioned, and where I can differentiate.",
    },
    {
      id: "fnd_landscape",
      icon: "binoculars",
      title: "Stress-test my business model",
      prompt:
        "Poke holes in my business model — where does it break, and what would an investor push on? I’ll describe it below.",
    },
    {
      id: "fnd_stress",
      icon: "lightbulb",
      title: "Plan next quarter",
      prompt:
        "Help me prioritize next quarter. I have a small team and limited runway — ask what we’re building and our top constraint, then propose a focused plan.",
    },
  ],
  Healthcare: [
    {
      id: "hc_lab",
      icon: "dna",
      title: "Think through a differential",
      prompt:
        "Think through a differential with me for a presentation I’ll describe — for learning, not medical advice.",
    },
    {
      id: "hc_paper",
      icon: "books",
      title: "Draft a patient handout",
      prompt:
        "Draft a one-page patient handout on a condition I’ll name (default to hypertension if I don’t) — plain language, non-alarmist, for a general adult audience.",
    },
    {
      id: "hc_handout",
      icon: "files",
      title: "Prep a difficult conversation",
      prompt:
        "Help me prepare for a difficult conversation with a patient or family — breaking bad news, goals of care, or a family disagreement.",
    },
  ],
  Writer: [
    {
      id: "wri_edit",
      icon: "pencil",
      title: "Find article angles",
      prompt:
        "Brainstorm 4-5 angles for an article, with a punchy one-line hook for each. I’ll share the topic next.",
    },
    {
      id: "wri_angles",
      icon: "lightbulb",
      title: "Polish my draft’s clarity",
      prompt:
        "Edit my draft for clarity and flow — keep my voice, cut anything that doesn’t earn its place. I’ll paste it next.",
    },
    {
      id: "wri_opening",
      icon: "pencil",
      title: "Write a first draft",
      prompt:
        "Write a first draft from my notes or brief. Match the tone and length I describe. Here’s what I’m working with:",
    },
  ],
  Educator: [
    {
      id: "edu_lesson",
      icon: "books",
      title: "Build a lesson plan",
      prompt:
        "Build a lesson plan for a topic I’ll share — include learning objectives, at least two activities, and a quick check for understanding.",
    },
    {
      id: "edu_problems",
      icon: "graduationCap",
      title: "Explain a concept simply",
      prompt:
        "Help me explain a concept to my students. I’ll share the concept and grade level — give a clear explanation and one analogy they’ll relate to.",
    },
    {
      id: "edu_rubric",
      icon: "files",
      title: "Diagnose a student misconception",
      prompt:
        "My students keep getting one concept wrong in the same way. I’ll describe what they do — help me diagnose the misconception and how to reteach it.",
    },
  ],
  Consultant: [
    {
      id: "con_deck",
      icon: "presentation",
      title: "Prep for a client meeting",
      prompt:
        "Help me prep for a client meeting — agenda, the questions to drive, likely pushback.",
    },
    {
      id: "con_proposal",
      icon: "files",
      title: "Crack a client case",
      prompt:
        "I’ll paste a business case — then help me map the core issue tree, key hypotheses, and the data that would prove or kill each one.",
    },
    {
      id: "con_case",
      icon: "lightbulb",
      title: "Build a consulting deck",
      prompt:
        "Give me a consulting deck structure — executive summary through recommendations — with a note on what to put on each slide.",
    },
  ],
  Researcher: [
    {
      id: "res_lit",
      icon: "binoculars",
      title: "Survey the literature",
      prompt:
        "Help me survey the literature on a topic I’ll share — map the key papers, name the active debates, and point to gaps worth exploring.",
    },
    {
      id: "res_method",
      icon: "files",
      title: "Design a research study",
      prompt:
        "I want to design a study. I’ll share my research question — then help me choose variables and controls and flag threats to validity.",
    },
    {
      id: "res_summary",
      icon: "books",
      title: "Draft a grant paragraph",
      prompt:
        "Give me a reusable grant-application paragraph template for a research proposal — I’ll swap in my project details.",
    },
  ],
  SoftwareEngineer: [
    {
      id: "swe_review_pr",
      icon: "code",
      title: "Review my PR diff",
      prompt:
        "Review the following PR diff for bugs, readability issues, and edge cases. I’ll paste the diff below.",
    },
    {
      id: "swe_debug",
      icon: "code",
      title: "Debug a stack trace",
      prompt:
        "Help me debug a stack trace — I’ll paste it below. Walk through it and point to the likely root cause.",
    },
    {
      id: "swe_tests",
      icon: "code",
      title: "Test my function",
      prompt:
        "I’ll paste a function next. Ask me the language and test framework if unclear, then write unit tests covering the happy path and the edge cases that matter.",
    },
  ],
  Other: [
    {
      id: "oth_brainstorm",
      icon: "lightbulb",
      title: "Brainstorm with me",
      prompt:
        "Brainstorm ideas with me — I’ll tell you the topic and you push back where it helps.",
    },
    {
      id: "oth_draft",
      icon: "pencil",
      title: "Explain, then quiz me",
      prompt:
        "Explain compound interest (or any topic I name) as simply as possible, then ask me a question to check I’ve understood it.",
    },
    {
      id: "oth_explain",
      icon: "chatsCircle",
      title: "Draft something for me",
      prompt:
        "I need a draft — I’ll describe what it is and who it’s for. Ask me for any details you need, then write a first version I can edit.",
    },
  ],
};

/** The starter tasks for a work type; none chosen reads as Other (`Dc`). */
export function firstTasksFor(workType: WorkType | undefined): FirstTask[] {
  return firstTasks[workType ?? "Other"] ?? firstTasks.Other;
}
