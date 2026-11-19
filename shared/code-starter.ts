/**
 * The phones' Code starter page ("Let's start coding", the official Claude
 * Android app 1.260923.20, `ozr`): three suggestions, each an emoji, a
 * title the app translates and the prompt the model gets. The prompts are
 * the official text, kept in English: they are sent to the model, not shown
 * as app copy.
 */
export interface CodeStarterSuggestion {
  id: "space-invaders" | "flashcard-study" | "todo-list";
  emoji: string;
  prompt: string;
}

export const codeStarterSuggestions: readonly CodeStarterSuggestion[] = [
  {
    id: "space-invaders",
    emoji: "🎮",
    prompt:
      "Build me a small, self-contained Space Invaders game I can play right in my browser. Make it visually polished and mobile-friendly — a single index.html with no dependencies.",
  },
  {
    id: "flashcard-study",
    emoji: "💬",
    prompt:
      "Build a simple flashcard study tool with flip-to-reveal cards and a progress counter. Single index.html, mobile-friendly, seed it with a few example cards so I can try it immediately.",
  },
  {
    id: "todo-list",
    emoji: "📝",
    prompt:
      "Build a clean, minimalist todo list with add, complete, and delete. Single index.html, mobile-friendly, no dependencies. Make it look polished — nice typography and subtle animations.",
  },
];
