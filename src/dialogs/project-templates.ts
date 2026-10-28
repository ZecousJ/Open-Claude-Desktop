// Student templates.
export const projectTemplates = [
  {
    title: "Study project",
    summary: "Learn and master any subject",
    heading: "Create a study project",
    question: "What course are you studying?",
    description:
      "A project for studying your course materials, where Claudex helps visualize key concepts, build comprehensive study guides, and tutor you according to your learning needs.",
  },
  {
    title: "Career project",
    summary: "Find the next step for your career",
    heading: "Create a career project",
    question: "What are you working towards?",
    description:
      "A project for exploring career opportunities, where Claudex helps match your skills to potential careers, improve your resume, and develop personalized roadmaps for professional growth.",
  },
  {
    title: "Research project",
    summary: "Analyze and organize research",
    heading: "Create a research project",
    question: "What are you researching?",
    description:
      "A project for developing academic research, where Claudex helps identify key themes in your research, create structured outlines, and provide feedback to improve your drafts.",
  },
] as const;

export type ProjectTemplate = (typeof projectTemplates)[number];
