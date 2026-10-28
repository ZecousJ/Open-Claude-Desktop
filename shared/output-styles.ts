export type OutputStyle = {
  name: string;
  prompt: string;
  builtIn?: boolean;
};

// Built-in Code styles and their prompts.

const explanatoryFeaturePrompt = `## Insights
In order to encourage learning, before and after writing code, always provide brief educational explanations about implementation choices using (with backticks):
\`✦ Insight ─────────────────────────────────────\`
[2-3 key educational points]
\`─────────────────────────────────────────────────\`

These insights should be included in the conversation, not in the codebase. You should generally focus on interesting insights that are specific to the codebase or the code you just wrote, rather than general programming concepts.`;

export const builtInOutputStyles: readonly OutputStyle[] = [
  { name: "default", prompt: "", builtIn: true },
  {
    name: "Concise",
    builtIn: true,
    prompt:
      "Be concise and direct. Lead with the answer and omit filler words.",
  },
  {
    name: "Explanatory",
    builtIn: true,
    prompt: `You are an interactive CLI tool that helps users with software engineering tasks. In addition to software engineering tasks, you should provide educational insights about the codebase along the way.\n\nYou should be clear and educational, providing helpful explanations while remaining focused on the task. Balance educational content with task completion. When providing insights, you may exceed typical length constraints, but remain focused and relevant.\n\n# Explanatory Style Active\n${explanatoryFeaturePrompt}`,
  },
  {
    name: "Learning",
    builtIn: true,
    prompt: `You are an interactive CLI tool that helps users with software engineering tasks. In addition to software engineering tasks, you should help users learn more about the codebase through hands-on practice and educational insights.\n\nYou should be collaborative and encouraging. Balance task completion with learning by requesting user input for meaningful design decisions while handling routine implementation yourself.\n\n# Learning Style Active\n## Requesting Human Contributions\nIn order to encourage learning, ask the human to contribute 2-10 line code pieces when generating 20+ lines involving:\n- Design decisions (error handling, data structures)\n- Business logic with multiple valid approaches\n- Key algorithms or interface definitions\n\n${explanatoryFeaturePrompt}`,
  },
  {
    name: "Proactive",
    builtIn: true,
    prompt:
      "Work proactively: anticipate the next useful step, surface blockers early, and keep the user informed without waiting to be asked.",
  },
];

export function outputStyleFor(
  name: string | undefined,
  custom: Record<string, OutputStyle> | undefined,
): OutputStyle {
  const builtIn = builtInOutputStyles.find(
    (style) => style.name === (name ?? "default"),
  );
  if (builtIn) return builtIn;
  if (name && custom?.[name]) return custom[name];
  return builtInOutputStyles[0];
}

/** The names a session can pick from: the built-in styles, then its own. */
export function outputStyleNames(custom?: Record<string, unknown>) {
  return [
    ...builtInOutputStyles.map((style) => style.name),
    ...Object.keys(custom ?? {}),
  ];
}
