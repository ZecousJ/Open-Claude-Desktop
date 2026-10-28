import type { StarterCategory } from "./starter-prompts";

/** The home starter ideas: Claudex's own catalog. */
export const starterCategories: StarterCategory[] = [
  {
    id: "research_analysis",
    title: "Research",
    icon: "binoculars",
    prompts: [
      {
        id: "research-1",
        requiredIntegrations: ["compass"],
        label:
          "Compare the leading note-taking apps for a small team and recommend one",
      },
      {
        id: "research-2",
        requiredIntegrations: ["compass"],
        label:
          "Find out what makes onboarding emails work and sum up the patterns",
      },
      {
        id: "research-3",
        requiredIntegrations: ["compass"],
        label: "Look into how other cities run successful bike-share programs",
      },
      {
        id: "research-4",
        requiredIntegrations: ["compass"],
        label:
          "Gather the latest evidence on four-day work weeks and weigh it up",
      },
      {
        id: "research-5",
        requiredIntegrations: ["compass"],
        label: "Survey open-source tools for monitoring a small web service",
      },
      {
        id: "research-6",
        requiredIntegrations: ["compass"],
        label: "Research how to price a new subscription product fairly",
      },
    ],
  },
  {
    id: "coding_development",
    title: "Code",
    icon: "code",
    prompts: [
      {
        id: "code-1",
        label: "Explain how a hash map works and build a tiny one in Python",
      },
      {
        id: "code-2",
        label: "Write a script that renames photos by the date they were taken",
      },
      {
        id: "code-3",
        label: "Review a function I paste for bugs and readability",
      },
      {
        id: "code-4",
        label: "Turn a messy shell one-liner into a readable, commented script",
      },
      {
        id: "code-5",
        label: "Design a database schema for a small library app",
      },
      {
        id: "code-6",
        label: "Build a simple to-do list page with HTML, CSS and JavaScript",
      },
    ],
  },
  {
    id: "learning_studying",
    title: "Learn",
    icon: "graduationCap",
    prompts: [
      {
        id: "learn-1",
        label: "Teach me the basics of statistics with everyday examples",
      },
      {
        id: "learn-2",
        label: "Make a two-week plan for learning everyday Spanish phrases",
      },
      {
        id: "learn-3",
        label: "Quiz me on the main events of the French Revolution",
      },
      {
        id: "learn-4",
        label: "Explain how vaccines train the immune system, step by step",
      },
      {
        id: "learn-5",
        label: "Help me understand compound interest with a worked example",
      },
      {
        id: "learn-6",
        label: "Summarize a classic book I name, chapter by chapter",
      },
    ],
  },
  {
    id: "writing_content_creation",
    title: "Write",
    icon: "pencil",
    prompts: [
      {
        id: "write-1",
        label: "Draft a friendly announcement for a team offsite",
      },
      {
        id: "write-2",
        label: "Tighten a paragraph I paste so it says more with fewer words",
      },
      {
        id: "write-3",
        label:
          "Write three subject lines for a newsletter about our latest release",
      },
      {
        id: "write-4",
        label: "Outline a blog post about lessons from a project that failed",
      },
      {
        id: "write-5",
        label: "Turn my bullet points into a short, clear project update",
      },
      { id: "write-6", label: "Write a thank-you note to a mentor" },
    ],
  },
  {
    id: "business_strategy",
    title: "Strategize",
    icon: "chartLine",
    prompts: [
      {
        id: "strategy-1",
        label: "Map the strengths and weaknesses of entering a new market",
      },
      {
        id: "strategy-2",
        label: "Build a simple pricing comparison against three competitors",
      },
      {
        id: "strategy-3",
        label: "Draft quarterly goals with measurable results for a small team",
      },
      {
        id: "strategy-4",
        label: "List the risks in a product launch plan and how to reduce them",
      },
      {
        id: "strategy-5",
        label: "Sketch a one-page business plan for a neighborhood café",
      },
      {
        id: "strategy-6",
        label: "Prepare talking points for a budget review meeting",
      },
    ],
  },
  {
    id: "design_creativity",
    title: "Create",
    icon: "palette",
    prompts: [
      {
        id: "create-1",
        label: "Suggest colors and fonts for a calm meditation app",
      },
      {
        id: "create-2",
        label: "Brainstorm names and taglines for a home-baking business",
      },
      { id: "create-3", label: "Design a simple logo concept as an SVG" },
      {
        id: "create-4",
        label: "Plan a mood board for a beach-themed birthday party",
      },
      {
        id: "create-5",
        label: "Write a short story that starts with a lost umbrella",
      },
      {
        id: "create-6",
        label: "Lay out a poster for a community clean-up day",
      },
    ],
  },
  {
    id: "life_stuff",
    title: "Life stuff",
    icon: "coffee",
    validAccountTiers: ["free", "claude_pro", "claude_max"],
    prompts: [
      {
        id: "life-1",
        label: "Plan a week of quick, healthy dinners with a shopping list",
      },
      {
        id: "life-2",
        label: "Help me make a monthly budget I can actually stick to",
      },
      {
        id: "life-3",
        label: "Plan a relaxed three-day trip to a city I choose",
      },
      { id: "life-4", label: "Suggest a beginner workout I can do at home" },
      {
        id: "life-5",
        label: "Help me sort out a cluttered closet in one weekend",
      },
      {
        id: "life-6",
        label: "Come up with gift ideas for a friend who loves hiking",
      },
    ],
  },
  {
    id: "career_chat",
    title: "Career chat",
    icon: "briefcase",
    validAccountTiers: ["raven"],
    prompts: [
      {
        id: "career-1",
        label: "Help me prepare answers to common interview questions",
      },
      { id: "career-2", label: "Review my resume summary and make it sharper" },
      { id: "career-3", label: "Plan how to ask my manager for a raise" },
      {
        id: "career-4",
        label: "Explore careers for someone who loves both data and people",
      },
      {
        id: "career-5",
        label: "Draft a polite message turning down a job offer",
      },
      { id: "career-6", label: "Set goals for my first 90 days in a new role" },
    ],
  },
  {
    id: "claudes_choice",
    title: "Claudex’s choice",
    icon: "lightbulb",
    prompts: [
      { id: "choice-1", label: "Tell me something surprising about octopuses" },
      {
        id: "choice-2",
        label: "Teach me a card trick I can learn in five minutes",
      },
      {
        id: "choice-3",
        label: "Invent a game I can play with things around the house",
      },
      { id: "choice-4", label: "Explain a famous paradox in plain words" },
      {
        id: "choice-5",
        label: "Recommend a hobby after asking me a few questions",
      },
      { id: "choice-6", label: "Write a riddle and let me guess the answer" },
    ],
  },
  {
    id: "drive",
    title: "From Drive",
    icon: "drive",
    isHidden: true,
    prompts: [
      {
        id: "drive-1",
        requiredIntegrations: ["drive"],
        label: "Summarize the most recent document in my Drive",
      },
      {
        id: "drive-2",
        requiredIntegrations: ["drive"],
        label:
          "Find my notes on an upcoming project in Drive and pull out the action items",
      },
      {
        id: "drive-3",
        requiredIntegrations: ["drive"],
        label: "Turn a spreadsheet in my Drive into a short written summary",
      },
      {
        id: "drive-4",
        requiredIntegrations: ["drive"],
        label: "Check my recent Drive documents for anything waiting on me",
      },
    ],
  },
  {
    id: "calendar",
    title: "From Calendar",
    icon: "calendar",
    isHidden: true,
    prompts: [
      {
        id: "calendar-1",
        requiredIntegrations: ["calendar"],
        label: "Look at my calendar and plan focus time for this week",
      },
      {
        id: "calendar-2",
        requiredIntegrations: ["calendar"],
        label: "Prepare me for my next meeting with a short briefing",
      },
      {
        id: "calendar-3",
        requiredIntegrations: ["calendar"],
        label: "Find an hour this week for a planning session",
      },
      {
        id: "calendar-4",
        requiredIntegrations: ["calendar"],
        label: "Sum up how much of last week went to meetings",
      },
    ],
  },
  {
    id: "gmail",
    title: "From Gmail",
    icon: "gmail",
    isHidden: true,
    prompts: [
      {
        id: "gmail-1",
        requiredIntegrations: ["gmail"],
        label: "Summarize the unread emails in my inbox",
      },
      {
        id: "gmail-2",
        requiredIntegrations: ["gmail"],
        label: "Draft replies to emails that have waited more than two days",
      },
      {
        id: "gmail-3",
        requiredIntegrations: ["gmail"],
        label: "Find emails about upcoming travel and list the details",
      },
      {
        id: "gmail-4",
        requiredIntegrations: ["gmail", "calendar", "drive"],
        label: "Combine my email, calendar and Drive into a briefing for today",
      },
    ],
  },
];
