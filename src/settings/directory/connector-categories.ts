/** Published taxonomy IDs and labels from O16 shared-l-p-m-2-C2TM0VYn
 * $X/Io/Ry/mt. Labels are lookup data; unknown strings never become slugs.
 * The two topics that carried the vendor name are labelled Claudex; their ids
 * stay as published. */
const categories = [
  ["topic-code", "Code"],
  ["topic-databases", "Databases"],
  ["topic-servers-cloud", "Servers & cloud"],
  ["topic-logs-errors", "Logs & errors"],
  ["topic-files-documents", "Files & documents"],
  ["topic-ai-models-agents", "AI models & agents"],
  ["topic-pipelines-jobs", "Automation & workflows"],
  ["topic-websites", "Websites"],
  ["topic-finances", "Finances"],
  ["topic-tickets-tasks", "Tickets & tasks"],
  ["topic-email-messages", "Email & messages"],
  ["topic-designs-media", "Designs & media"],
  ["topic-reference-docs", "Reference docs"],
  ["topic-dependencies-packages", "Dependencies & packages"],
  ["topic-music-podcasts", "Music & podcasts"],
  ["topic-papers-articles", "Papers & articles"],
  ["topic-notes-memory", "Notes & memory"],
  ["topic-books", "Books"],
  ["topic-contacts-leads", "Contacts & leads"],
  ["topic-pull-requests", "Pull requests"],
  ["topic-problems-puzzles", "Problems & puzzles"],
  ["topic-courses-lessons", "Courses & lessons"],
  ["topic-events-tickets", "Events & tickets"],
  ["topic-apis", "APIs"],
  ["topic-claude-history", "Claudex history"],
  ["topic-claude-settings", "Claudex settings"],
  ["topic-recipes-meals", "Recipes & meals"],
  ["topic-workouts-health-records", "Health & exercise data"],
  ["topic-trips", "Trips"],
  ["department-engineering", "Engineering"],
  ["department-data", "Data"],
  ["department-it-security", "IT & security"],
  ["department-product", "Product"],
  ["department-design", "Design"],
  ["department-marketing", "Marketing"],
  ["department-sales", "Sales"],
  ["department-customer-support", "Customer support"],
  ["department-finance", "Finance"],
  ["department-legal", "Legal"],
  ["department-hr", "HR"],
  ["department-operations", "Operations"],
  ["industry-health-life-sciences", "Health & life sciences"],
  ["industry-financial-services", "Financial services"],
  ["industry-education", "Education"],
  ["industry-nonprofit", "Nonprofit"],
  ["industry-retail-ecommerce", "Retail & e-commerce"],
  ["industry-travel-hospitality", "Travel & hospitality"],
  ["industry-media-entertainment", "Media & entertainment"],
  ["industry-government", "Government"],
  ["industry-legal", "Legal"],
  ["industry-real-estate", "Real estate"],
  ["industry-energy", "Energy"],
  ["industry-manufacturing", "Manufacturing"],
  ["industry-transportation-logistics", "Transportation & logistics"],
  ["industry-utilities", "Utilities"],
  ["industry-agriculture", "Agriculture"],
  ["industry-mining", "Mining"],
  ["industry-construction", "Construction"],
  ["industry-telecommunications", "Telecommunications"],
  ["industry-insurance", "Insurance"],
  ["industry-research-academia", "Research & academia"],
  ["industry-events", "Events"],
  ["industry-fitness-wellness", "Fitness & wellness"],
  ["industry-agencies-staffing", "Agencies & staffing"],
  ["industry-software-saas", "Software & SaaS"],
  ["everyday-life-travel", "Travel"],
  ["everyday-life-research", "Research"],
  ["everyday-life-health", "Health"],
  ["everyday-life-fitness", "Fitness"],
  ["everyday-life-music", "Music"],
  ["everyday-life-food", "Food"],
  ["everyday-life-shopping", "Shopping"],
  ["everyday-life-sports", "Sports"],
  ["everyday-life-work-career", "Work & career (my own)"],
  ["everyday-life-home", "Home"],
  ["everyday-life-learning", "Learning"],
  ["everyday-life-money", "Money & personal finance"],
  ["everyday-life-faith", "Faith"],
  ["everyday-life-family-relationships", "Family & relationships"],
  ["everyday-life-games", "Games"],
  ["everyday-life-writing", "Writing"],
  ["everyday-life-film-tv", "Film & TV"],
  ["everyday-life-news", "News"],
  ["everyday-life-photos-videos", "Photos & videos (my own)"],
  ["everyday-life-social-media", "Social media"],
  ["everyday-life-books-reading", "Books & reading"],
  ["everyday-life-maps-transit", "Maps & transit"],
  ["everyday-life-beauty-grooming", "Beauty & grooming"],
  ["everyday-life-volunteering-giving", "Volunteering & giving"],
  ["everyday-life-arts-crafts", "Arts & crafts"],
  ["everyday-life-cars", "Cars"],
  ["everyday-life-events-going-out", "Events & going out"],
  ["topic-medicine", "Medicine"],
  ["topic-science", "Science"],
  ["topic-maths", "Maths"],
  ["topic-languages", "Languages"],
  ["topic-history", "History"],
  ["topic-philosophy-religion", "Philosophy & religion"],
  ["topic-the-arts", "The arts"],
  ["topic-computing", "Computing (as a hobby)"],
  ["topic-engineering", "Engineering"],
  ["topic-law", "Law"],
  ["topic-economics", "Economics"],
  ["topic-politics-government", "Politics & government"],
  ["topic-psychology", "Psychology"],
  ["topic-sociology-anthropology", "Sociology & anthropology"],
  ["topic-geography", "Geography"],
  ["topic-business-management", "Business & management"],
  ["topic-education", "Education (as a field)"],
  ["productivity", "Productivity"],
  ["sales-and-marketing", "Sales and marketing"],
  ["other", "Other"],
] as const;

/** Source Yh/J6/ws and legacy h9/DK preserve the earlier filter vocabulary. */
const aliases: Record<string, string> = {
  code: "topic-code",
  "developer-tools": "topic-code",
  development: "topic-code",
  "development tools": "topic-code",
  data: "department-data",
  "data-analytics": "department-data",
  "data & analytics": "department-data",
  analytics: "department-data",
  design: "department-design",
  creative: "department-design",
  "financial-services": "industry-financial-services",
  health: "everyday-life-health",
  "consumer-health": "everyday-life-health",
  "consumer health": "everyday-life-health",
  "health-life-sciences": "industry-health-life-sciences",
  "health & life sciences": "industry-health-life-sciences",
  "life-sciences": "industry-health-life-sciences",
  nonprofit: "industry-nonprofit",
  travel: "everyday-life-travel",
  "media-entertainment": "industry-media-entertainment",
  "media & entertainment": "industry-media-entertainment",
  legal: "department-legal",
  education: "industry-education",
  engineering: "department-engineering",
  "commerce-shopping": "industry-retail-ecommerce",
  "commerce & shopping": "industry-retail-ecommerce",
  communication: "topic-email-messages",
  finance: "department-finance",
  "files-documents": "topic-files-documents",
  "contacts-leads": "topic-contacts-leads",
  "reference-docs": "topic-reference-docs",
  "tickets-tasks": "topic-tickets-tasks",
  "email-messages": "topic-email-messages",
  "designs-media": "topic-designs-media",
  "notes-memory": "topic-notes-memory",
  websites: "topic-websites",
  databases: "topic-databases",
  sales: "department-sales",
  marketing: "department-marketing",
  "logs-errors": "topic-logs-errors",
  "pipelines-jobs": "topic-pipelines-jobs",
  events: "topic-events-tickets",
  "servers-cloud": "topic-servers-cloud",
  "healthcare-life-sciences": "industry-health-life-sciences",
  "retail-ecommerce": "industry-retail-ecommerce",
};

export function connectorCategory(
  value?: string,
): { id: string; label: string } | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  const id = aliases[key] ?? key;
  const exact = categories.find(([candidate]) => candidate === id);
  if (exact) return { id: exact[0], label: exact[1] };
  const labels = categories.filter(([, label]) => label.toLowerCase() === key);
  return labels.length === 1
    ? { id: labels[0][0], label: labels[0][1] }
    : undefined;
}

export function connectorCategoryGroups() {
  return (
    [
      ["Topic", "topic-"],
      ["Department", "department-"],
      ["Industry", "industry-"],
      ["Everyday life", "everyday-life-"],
    ] as const
  ).map(([label, prefix]) => ({
    label,
    prefix,
    categories: categories
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

/** Source shared-0 bc writes scope/type as separate pathname segments. */
export const connectorDirectoryTypes = [
  { id: "all", label: "All", path: undefined },
  { id: "trending", label: "Trending", path: "trending", field: "isTrending" },
  { id: "new", label: "New", path: "new", field: "isNew" },
  { id: "verified", label: "Verified", path: "verified" },
  { id: "community", label: "Community", path: "community" },
  {
    id: "inChatUi",
    label: "In-chat UI",
    path: "in-chat-ui",
    field: "inChatUi",
  },
  {
    id: "desktopExtension",
    label: "Desktop extensions",
    path: "desktop-extensions",
    field: "desktopExtension",
  },
] as const;
export type ConnectorDirectoryType =
  (typeof connectorDirectoryTypes)[number]["id"];

export type ConnectorFilterAvailability = {
  isTrending: boolean;
  isNew: boolean;
  inChatUi: boolean;
  desktopExtension: boolean;
};
export function connectorFilterAvailability(
  entries: readonly {
    isTrending?: boolean;
    isNew?: boolean;
    inChatUi?: boolean;
    desktopExtension?: boolean;
  }[],
): ConnectorFilterAvailability {
  return {
    isTrending: entries.some((entry) => entry.isTrending !== undefined),
    isNew: entries.some((entry) => entry.isNew !== undefined),
    inChatUi: entries.some((entry) => entry.inChatUi !== undefined),
    desktopExtension: entries.some(
      (entry) => entry.desktopExtension !== undefined,
    ),
  };
}
