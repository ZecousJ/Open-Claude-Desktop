/**
 * The Cowork home's ideas (src/cowork/CoworkIdeas.tsx): sets of three task
 * ideas the person steps through with the shuffle button at the heading.
 *
 * The first set is the one the home has always shown ("Ideas for you",
 * capture R-Cowork, owner's 2026-09-23 recording; live claude.ai bundle,
 * 2026-10-12: the home's ideas, unchanged), whose prompts Claudex words for
 * the selected folder. The four sets after it, their names, labels and
 * prompts are the live Cowork suggestions' categories (live claude.ai
 * bundle, 2026-10-12: "Pick a task, any task", "Tidy up and get
 * organized", "Plan for what’s ahead", "Turn messy data into action"), in
 * that order; the shuffle steps to the next set and wraps around.
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
    name: "Pick a task, any task",
    ideas: [
      {
        id: "initial-1",
        thumbnail: "prep",
        label: "Optimize my week",
        prompt: `Help me plan and optimize my week. I have my Google Calendar open and ready for you to review and edit.

First, review my calendar and show me a summary:
- Total meetings
- Busiest days
- Where I have gaps of 2+ hours

Before proposing changes, ask me about:
- What I’m trying to accomplish this week
- How much focus time I need and for what
- Any deadlines or commitments not on my calendar
- Which types of meetings I should decline or shorten
- Personal commitments or boundaries I want to protect

Then show me your top 3-5 proposed changes with explanations:
- Focus blocks to add
- Meetings to decline or reschedule
- Time conflicts to resolve

Start with the highest-impact changes first. Once I approve each change, make the edits directly in my calendar one at a time.`,
      },
      {
        id: "initial-2",
        thumbnail: "organize",
        label: "Organize my screenshots",
        prompt: `Help me organize recent screenshots on my Desktop.

First, scan my Desktop and count how many screenshots/images are there. Show me:
- Total count
- Date range (oldest to newest)

Then, focus only on screenshots from the last 14 days. For each one:
- Identify what it shows
- Suggest a descriptive filename
- Propose which folder it belongs in (or if it can be deleted)

Group similar screenshots together. Show me the plan before making any changes.

After I approve, start by organizing just 10 files as a preview. If there are more than 10 files, check in with me before continuing with the rest.`,
      },
      {
        id: "initial-3",
        thumbnail: "file",
        label: "Find insights in files",
        prompt: `Help me find patterns and insights across [my voice memos / meeting transcripts / documents / journal entries / specify folder]. I have messy, unstructured files and want to understand what themes are emerging.

First, scan the folder and show me a summary:
- Total files
- Date range (oldest to newest)
- Types of content

Before analyzing, ask me:
- What I’m hoping to discover (recurring themes, contradictions, evolution of thinking, action items, or something else)
- Whether certain files or time periods should be prioritized
- What format would be most useful for the final analysis

If there are more than 20 files, start by analyzing just the 10 most recent files.

Show me the top 3-5 patterns you found with 2-3 specific examples for each pattern. Once I confirm you’re on the right track, analyze the remaining files.`,
      },
    ],
  },
  {
    id: "organize",
    name: "Tidy up and get organized",
    ideas: [
      {
        id: "organize-downloads",
        thumbnail: "organize",
        label: "Clean up my Downloads folder",
        prompt: `Help me organize my Downloads folder.

First, scan and show me a summary:
- Total files and total size
- Files older than 30 days
- Largest files taking up space

Before organizing, ask me:
- What categories or folder structure would be most useful
- Whether I want to delete or archive old files
- If there are specific file types I want to prioritize (documents, images, installers, etc.)

Then focus only on files older than 30 days first. Show me a proposed plan for these old files:
- Categories to create
- Files to delete (installers, duplicates, temp files)
- Files to keep with where they should go

After I approve, organize the first 15 old files as a preview. If there are more files, check in before continuing.`,
      },
      {
        id: "organize-photos",
        thumbnail: "organize",
        label: "Organize photos by event/date",
        prompt: `Help me organize photos on my [Desktop/Downloads/specify location].

First, scan the folder and show me a summary:
- Total photos
- Date range (oldest to newest)
- Rough size breakdown

Before organizing, ask me:
- How I’d like them organized (by date, by event, by person)
- Whether there are specific events or time periods I should know about
- What folder structure would work best
- If any photos can be deleted (duplicates, blurry ones, screenshots)

Focus only on photos from the last 3 months first. Show me a proposed plan with examples from 3-4 different groups so I can show you how I’d organize them.

After I approve, organize just 20 photos as a preview. If there are more than 20, check in before continuing with the rest.`,
      },
      {
        id: "organize-inbox",
        thumbnail: "comms",
        label: "Organize my inbox",
        prompt: `Help me organize and clean up my email inbox.

First, scan my inbox and show me a summary:
- Total unread emails
- Emails older than 30 days
- The main senders or types of emails

Before organizing, ask me:
- What categories or folders I want to create
- Which types of emails I want to archive or delete
- Whether there are specific senders I want to prioritize or filter
- Any email patterns I want to address (newsletters, promotions, etc.)

Focus only on emails older than 30 days first — these are easiest to clean up. Show me a proposed plan:
- Which emails to archive
- Which to delete
- Which need action

If there are more than 50 old emails, start with a batch of 20 so I can check your approach. Once I approve, process that batch.`,
      },
    ],
  },
  {
    id: "prep",
    name: "Plan for what’s ahead",
    ideas: [
      {
        id: "prep-meeting",
        thumbnail: "prep",
        label: "Prep for my next meeting",
        prompt: `I have a meeting with [a company] [tomorrow].

Before researching, ask me:
- What the meeting is about
- What I already know about them
- What I’m trying to accomplish
- What would be most useful to know going in

Then research them and show me what you found:
- Company overview
- Recent news (last 3 months)
- Key people I’ll be meeting with
- Their LinkedIn for recent updates

Show me an outline of the one-pager with the 3-5 most important points before writing the full doc. Once I approve, create the final one-pager.`,
      },
      {
        id: "prep-vacation",
        thumbnail: "prep",
        label: "Plan my next vacation",
        prompt: `Help me plan my next vacation.

Before researching, ask me:
- Where I’m thinking of going (or if I’m open to suggestions)
- When I want to travel and for how long
- What my budget is
- What kind of trip I’m looking for (relaxing, adventure, cultural, food-focused, etc.)

Then research the top 3 destinations that fit my criteria and show me a comparison:
- Estimated costs
- Best time to visit
- What makes each unique

Once I pick my top choice, research that destination in detail:
- Check current flight prices
- Find 3-4 accommodation options
- Suggest a day-by-day outline

Show me this proposed itinerary with estimated costs before creating the final trip plan.`,
      },
      {
        id: "prep-interview",
        thumbnail: "prep",
        label: "Prepare for a job interview",
        prompt: `I have a job interview coming up for [role] at [company].

Before researching, ask me:
- What the role is and what level
- What I already know about the company
- What I’m most nervous or uncertain about
- If I have the job description or any interview details

Then research the company and role, and show me what I found:
- Company overview and recent news (last 6 months)
- What this role typically involves
- Common interview questions for this type of role
- The interview team on LinkedIn (if you have names)

Show me an outline covering these 3-5 topics before creating the full prep doc:
- Key points about the company to mention
- How my background connects to what they need
- Questions I should ask them
- 3-4 likely interview questions with suggested talking points

Once I approve, create a complete interview prep guide I can review before the interview.`,
      },
    ],
  },
  {
    id: "data",
    name: "Turn messy data into action",
    ideas: [
      {
        id: "data-slack",
        thumbnail: "comms",
        label: "Catch me up on Slack",
        prompt: `Help me catch up on what I’ve missed in Slack.

Before reading, ask me:
- Which channels or DMs I should focus on (or check everything)
- How far back to look (since yesterday, last week, specific date)
- What I’m most concerned about missing (decisions, @mentions, urgent items, project updates)
- Whether there are specific topics or people to prioritize

Then scan those channels and show me a summary:
- Total unread messages
- Breakdown by channel

Focus on messages that @mention me, contain decisions, or are marked urgent first.

Show me the top 5 most important updates with context and links to the threads. If there are more than 30 unread messages total, start with these top 5 and ask if you should summarize more.`,
      },
      {
        id: "data-voice-memos",
        thumbnail: "file",
        label: "Turn voice memos into a doc",
        prompt: `Help me turn my voice memos into an organized document. I have [voice memos / audio recordings] in [specify location] that I want transcribed and organized.

First, scan the folder and show me:
- How many audio files
- Total duration
- Date range

Before transcribing, ask me:
- What these recordings are about
- How I’d like them organized (chronologically, by topic, by theme)
- Whether I want verbatim transcripts or cleaned-up summaries
- What the final document should be (meeting notes, journal entries, ideas list, etc.)

If there are more than 5 recordings, start by transcribing just the 3 most recent ones. Show me the transcribed content and proposed organization structure.

Once I approve the approach, transcribe and organize the remaining recordings.`,
      },
      {
        id: "data-spreadsheet",
        thumbnail: "file",
        label: "Pull data into a spreadsheet",
        prompt: `I’m on a page with [job listings / products / directory entries] I want to extract.

First, scan the page and show me what you see:
- How many items total
- What fields are available (title, price, location, description, etc.)

Before extracting, ask me:
- Which fields I want in the spreadsheet
- If there are any I should skip

Then show me a preview with the first 3-5 items extracted so I can confirm the format looks right.

If there are more than 20 items on this page, extract them in batches of 10. If there are multiple pages, just do the first page and check with you before continuing.`,
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
