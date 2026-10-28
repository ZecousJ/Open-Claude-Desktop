// Work-function defaults.
import type { WorkType } from "../../shared/settings-extras";

export const starterWorkCategories: Record<WorkType, readonly string[]> = {
  "Product Management": [
    "writing_content_creation",
    "research_analysis",
    "business_strategy",
  ],
  Engineering: [
    "coding_development",
    "writing_content_creation",
    "research_analysis",
  ],
  "Human Resources": [
    "writing_content_creation",
    "research_analysis",
    "business_strategy",
  ],
  Finance: [
    "writing_content_creation",
    "research_analysis",
    "business_strategy",
  ],
  Marketing: [
    "writing_content_creation",
    "research_analysis",
    "business_strategy",
  ],
  Sales: ["writing_content_creation", "research_analysis", "business_strategy"],
  Operations: [
    "writing_content_creation",
    "research_analysis",
    "business_strategy",
  ],
  "Data Science": [
    "coding_development",
    "writing_content_creation",
    "research_analysis",
  ],
  Design: [
    "design_creativity",
    "research_analysis",
    "writing_content_creation",
  ],
  Legal: ["writing_content_creation", "research_analysis", "business_strategy"],
  Scientist: [
    "research_analysis",
    "coding_development",
    "writing_content_creation",
  ],
  Student: [
    "learning_studying",
    "writing_content_creation",
    "research_analysis",
  ],
  Founder: [
    "business_strategy",
    "writing_content_creation",
    "coding_development",
  ],
  Healthcare: [
    "research_analysis",
    "writing_content_creation",
    "learning_studying",
  ],
  Writer: [
    "writing_content_creation",
    "design_creativity",
    "research_analysis",
  ],
  Educator: [
    "learning_studying",
    "writing_content_creation",
    "research_analysis",
  ],
  Consultant: [
    "business_strategy",
    "research_analysis",
    "writing_content_creation",
  ],
  Researcher: [
    "research_analysis",
    "writing_content_creation",
    "coding_development",
  ],
  SoftwareEngineer: [
    "coding_development",
    "writing_content_creation",
    "research_analysis",
  ],
  Other: [
    "writing_content_creation",
    "learning_studying",
    "coding_development",
  ],
};
