import type {
  NextStepOffer,
  NextStepScenario,
} from "../../shared/chat-suggestions";

// .
export const nextStepCopy: Record<
  NextStepOffer,
  { caption: string; chip: string; prompts: Record<NextStepScenario, string> }
> = {
  build_doc: {
    caption: "Get this as a document you can edit and share.",
    chip: "Create a document",
    prompts: {
      answer_to_work:
        "Turn your last answer into a document I can edit and share. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
      next_after_completion:
        "Write a document to go with what you just made, and refer to that work by name so the two stay linked. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
    },
  },
  build_sheet: {
    caption: "Get this as a spreadsheet you can sort and update.",
    chip: "Create a spreadsheet",
    prompts: {
      answer_to_work:
        "Put the numbers and details from your last answer into a spreadsheet I can sort and update. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
      next_after_completion:
        "Make a spreadsheet to go with what you just made, and refer to that work by name so the two stay linked. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
    },
  },
  make_deck: {
    caption: "Get this as a slide deck you can present.",
    chip: "Create a slide deck",
    prompts: {
      answer_to_work:
        "Turn your last answer into a slide deck I can present. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
      next_after_completion:
        "Make a slide deck from what you just made, and refer to that work by name so the two stay linked. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
    },
  },
  write_brief: {
    caption: "Get this as a one-page brief for your team.",
    chip: "Write a brief",
    prompts: {
      answer_to_work:
        "Turn your last answer into a one-page brief for my team. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
      next_after_completion:
        "Write a one-page brief that summarizes what you just made, and refer to that work by name so the two stay linked. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
    },
  },
  draft_email: {
    caption: "Get this as an email draft, ready to send.",
    chip: "Draft an email",
    prompts: {
      answer_to_work:
        "Turn your last answer into an email draft I can send. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
      next_after_completion:
        "Draft an email that shares what you just made, and refer to that work by name so the two stay linked. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
    },
  },
  make_task_list: {
    caption: "Get this as a task list you can work through.",
    chip: "Make a task list",
    prompts: {
      answer_to_work:
        "Turn your last answer into a task list with clear next steps. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
      next_after_completion:
        "Make a task list of next actions from what you just made, and refer to that work by name so the two stay linked. Build it right here in this chat and ask me at most one question. If something’s missing, use a sensible default and tell me what you assumed.",
    },
  },
};
