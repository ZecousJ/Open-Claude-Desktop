/**
 * The phones' Code starter page: three suggestions, each an emoji, a title the
 * app translates and the prompt the model gets. The prompts are kept
 * in English: they are sent to the model, not shown as app copy.
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
      "Make a small arcade shooter in the spirit of Space Invaders that runs in a browser: one index.html, no libraries, keyboard and touch controls, and a tidy look that works on a phone.",
  },
  {
    id: "flashcard-study",
    emoji: "💬",
    prompt:
      "Make a flashcard app for studying: tapping a card turns it over to show the answer, a counter shows how far through the deck I am, and a handful of sample cards are included so it works straight away. Keep it to one index.html that works on a phone.",
  },
  {
    id: "todo-list",
    emoji: "📝",
    prompt:
      "Make a minimal to-do list where I can add items, tick them off and remove them. One index.html with no dependencies, careful typography and light animations, comfortable to use on a phone.",
  },
];
