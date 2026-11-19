/**
 * The reply feedback dialog: a service that collects reply feedback, whose
 * user agreed in Settings → Privacy. `replyFeedback=excerpt` also lets the
 * dialog offer the conversation.
 */
import type { FixtureDomain } from "./index";

export const replyFeedbackFixture: FixtureDomain = {
  params: {
    replyFeedback:
      "1 | excerpt | code-retry | code-queued: explicit consented feedback states; excerpt adds the conversation box",
  },
  bridge: ({ params, state }) => {
    const mode = params.get("replyFeedback");
    if (!mode) return {};
    state.settings.helpImproveClaudex = true;
    const ratings: Record<string, "up" | "down"> = {};
    let codeReports = 0;
    return {
      setReplyFeedback: async (conversationId, turnId, rating) => {
        const key = JSON.stringify([conversationId, turnId]);
        if (rating) ratings[key] = rating;
        else delete ratings[key];
        return { ...ratings };
      },
      reportingStatus: async () => ({
        diagnostics: true,
        feedback: true,
        allowConversationExcerpt: mode === "excerpt",
        consented: true,
        codeSessionFeedback: true,
      }),
      submitReplyFeedback: async () => ({ sent: true }),
      submitCodeFeedback: async () => {
        codeReports++;
        if (mode === "code-retry" && codeReports === 1) throw Error("Synthetic collector failure");
        return mode === "code-queued" ? { sent: false, queued: true } : { sent: true };
      },
    };
  },
};
