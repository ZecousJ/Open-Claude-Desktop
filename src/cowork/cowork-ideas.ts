/**
 * The Cowork home's ideas (src/cowork/CoworkIdeas.tsx): sets of three task
 * ideas the person steps through with the shuffle button at the heading.
 * The first set is the home's own, worded for the selected folder; the
 * shuffle steps to the next set and wraps around.
 */

/** Which illustration a row draws (src/CoworkIdeaIcons.tsx). */
export type CoworkIdeaThumbnail =
  "prep" | "comms" | "skill" | "organize" | "file";

export interface CoworkIdea {
  id: string;
  thumbnail: CoworkIdeaThumbnail;
  /** The row's text (English; translated where it is shown). */
  label: string;
  /** What a click puts in the composer (English; translated when picked). */
  prompt: string;
}

export interface CoworkIdeaCategory {
  id: string;
  /** The heading the shuffle button shows. */
  name: string;
  ideas: CoworkIdea[];
}

export const coworkIdeaCategories: CoworkIdeaCategory[] = [
  {
    id: "for-you",
    name: "Ideas for you",
    ideas: [
      {
        id: "daily-briefing",
        thumbnail: "prep",
        label: "Send me a daily briefing",
        prompt:
          "Read the files in my selected folder and prepare a concise daily briefing.",
      },
      {
        id: "organize-inbox",
        thumbnail: "comms",
        label: "Organize my inbox",
        prompt:
          "Help me organize the files in my selected folder. First propose a plan before making any changes.",
      },
      {
        id: "setup-cowork",
        thumbnail: "skill",
        label: "Customize Cowork for me",
        prompt:
          "Help me create reusable instructions and workflows for the work in this folder.",
      },
    ],
  },
  {
    id: "initial",
    name: "Start with something small",
    ideas: [
      {
        id: "initial-1",
        thumbnail: "prep",
        label: "Plan my week",
        prompt:
          "Help me plan my week. Ask what is on my plate and what matters most, then lay out a day-by-day plan with time for focused work and room for surprises.",
      },
      {
        id: "initial-2",
        thumbnail: "organize",
        label: "Sort my screenshots",
        prompt:
          "Go through the screenshots in my selected folder and sort them into subfolders by topic. Propose the folder names and show me the plan before moving anything.",
      },
      {
        id: "initial-3",
        thumbnail: "file",
        label: "Spot patterns in my files",
        prompt:
          "Read the documents in my selected folder and tell me what stands out: recurring themes, open questions and anything that looks out of date. Fit it on one page.",
      },
    ],
  },
  {
    id: "organize",
    name: "Clear the clutter",
    ideas: [
      {
        id: "organize-downloads",
        thumbnail: "organize",
        label: "Tidy my Downloads folder",
        prompt:
          "Look through my Downloads folder and suggest what to keep, file away or delete. Group similar files, point out large or duplicate ones, and wait for my go-ahead before changing anything.",
      },
      {
        id: "organize-photos",
        thumbnail: "organize",
        label: "Group photos by date",
        prompt:
          "Organize the photos in my selected folder into folders by year and month, using the date each one was taken. Show me the plan first and never delete a photo.",
      },
      {
        id: "organize-inbox",
        thumbnail: "comms",
        label: "Get my inbox under control",
        prompt:
          "Help me get my inbox under control. Group what is waiting by urgency, draft short replies for the quick ones, and list what needs a decision from me.",
      },
    ],
  },
  {
    id: "prep",
    name: "Get ready for what’s next",
    ideas: [
      {
        id: "prep-meeting",
        thumbnail: "prep",
        label: "Prepare for my next meeting",
        prompt:
          "Help me prepare for my next meeting. Ask who it is with and what it is about, then gather the relevant notes and files and give me a short briefing with questions to raise.",
      },
      {
        id: "prep-vacation",
        thumbnail: "prep",
        label: "Plan a getaway",
        prompt:
          "Help me plan a short trip. Ask about my dates, budget and the kind of places I enjoy, then suggest a day-by-day plan and a packing list.",
      },
      {
        id: "prep-interview",
        thumbnail: "prep",
        label: "Get ready for an interview",
        prompt:
          "Help me get ready for a job interview. Ask about the role and the company, go over likely questions with me, help me shape my answers and suggest questions I can ask them.",
      },
    ],
  },
  {
    id: "data",
    name: "Make sense of scattered information",
    ideas: [
      {
        id: "data-slack",
        thumbnail: "comms",
        label: "Catch me up on team chat",
        prompt:
          "Catch me up on what I missed in my team’s chat. Summarize the main discussions and decisions, point out anything that mentions me, and list what I should reply to.",
      },
      {
        id: "data-voice-memos",
        thumbnail: "file",
        label: "Turn voice notes into a document",
        prompt:
          "Turn the voice notes in my selected folder into a tidy document. Transcribe them, group related points under headings and list any action items at the end.",
      },
      {
        id: "data-spreadsheet",
        thumbnail: "file",
        label: "Collect figures into a spreadsheet",
        prompt:
          "Pull the figures scattered across the files in my selected folder into one spreadsheet. Show me the columns you plan to use before you start, and note where each value came from.",
      },
    ],
  },
];

/** The set after `index`; the last one wraps to the first. */
export function nextIdeaCategory(
  index: number,
  count = coworkIdeaCategories.length,
): number {
  return count > 0 ? (index + 1) % count : 0;
}

/** Where "Hide suggestions" is remembered on this computer. */
export const coworkIdeasHiddenKey = "claudex.cowork.ideas.hidden";

/** Whether the person hid the ideas (storage may be missing or blocked). */
export function coworkIdeasHidden(
  storage: Pick<Storage, "getItem"> | undefined,
): boolean {
  try {
    return storage?.getItem(coworkIdeasHiddenKey) === "1";
  } catch {
    return false;
  }
}

/** Remembers that the ideas are hidden; they stay hidden until the page is left if it cannot. */
export function hideCoworkIdeas(
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(coworkIdeasHiddenKey, "1");
  } catch {
    // Hidden for this view only.
  }
}
