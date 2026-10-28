/**
 * Skills included with Claudex, offered on Discover. Adding one writes it
 * to the profile's skills folder like any skill the person creates.
 */
export interface StarterSkill {
  name: string;
  title: string;
  description: string;
  instructions: string;
  icon: "data" | "writing" | "learn" | "web";
}

export const starterSkills: StarterSkill[] = [
  {
    name: "data-analysis",
    title: "Data",
    description:
      "Query, chart and explain your data — tables, spreadsheets and reports in one place.",
    instructions:
      "Help the user explore the data files they explicitly select. Inspect structure and quality first. State assumptions, preserve source files, and use reproducible calculations. Check units, missing values and outliers. Summarize findings and provide useful charts or a report in the workspace.",
    icon: "data",
  },
  {
    name: "writing-partner",
    title: "Writing",
    description:
      "Turn a rough idea into a clear draft, with thoughtful editing and a consistent voice.",
    instructions:
      "Help draft and revise the user's document. Determine the audience and purpose from context. Preserve the user's meaning and voice. Use clear, specific language and check claims that require verification. Offer a complete useful draft, then make requested changes.",
    icon: "writing",
  },
  {
    name: "learning-guide",
    title: "Learn",
    description:
      "Build understanding with explanations, worked examples and a little practice.",
    instructions:
      "Teach the topic at the learner's level. Start with the core idea, explain terms as needed, and connect concepts with concrete examples. Use small exercises to test understanding when appropriate. Correct mistakes kindly and state uncertainty.",
    icon: "learn",
  },
  {
    name: "web-artifacts",
    title: "Web artifacts",
    description:
      "Create interactive pages and small tools you can preview alongside the conversation.",
    instructions:
      "Build the requested interactive tool as a complete self-contained HTML document in a fenced html code block. Include CSS and JavaScript inline. Do not require external network resources. Make the layout responsive and accessible, use real behavior for controls, and avoid placeholder content.",
    icon: "web",
  },
];
