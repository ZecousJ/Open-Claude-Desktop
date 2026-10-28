import type { CapabilityTip } from "../../shared/chat-suggestions";

// Hn/Un.
export const capabilityTipCopy: Record<
  CapabilityTip,
  { body: string; action?: string }
> = {
  document_creation: {
    body: "Ask Claudex to make this a Word, Excel, PowerPoint or PDF file you can download without copying and pasting.",
    action: "Add to message",
  },
  cowork: {
    body: "Hand off complex tasks in Cowork—Claudex lets you know when it’s done.",
    action: "Open Cowork",
  },
  file_uploads: {
    body: "Next time, attach the file itself. Claudex can read the whole thing, formatting included.",
  },
  projects: {
    body: "Working from the same brief each time? A project keeps your reference material ready for every chat.",
    action: "Open Projects",
  },
  artifacts: {
    body: "Generate code, documents, and designs in a dedicated window alongside your conversation.",
    action: "Add to message",
  },
  memory: {
    body: "You’re in control of what Claudex knows about you. Turn on memory, and see or edit what it keeps.",
    action: "Turn on memory",
  },
  scheduled_tasks: {
    body: "Doing this every week? Set it up as a scheduled task in Cowork.",
    action: "Open scheduled tasks",
  },
  screenshots: {
    body: "Next time, paste in a screenshot. Claudex can read the interface, chart or error straight from the file.",
  },
  chat_history_search: {
    body: "Looking for something from an earlier chat? Ask Claudex to search your past chats.",
    action: "Add to message",
  },
  skills: {
    body: "Teach Claudex once: Save this as a skill, and you choose when it applies.",
    action: "Open Skills",
  },
  temporary_chat: {
    body: "Use an incognito chat for anything you don’t want in your history or Claudex’s memory.",
    action: "New incognito chat",
  },
};
