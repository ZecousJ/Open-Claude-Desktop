import type { AppController } from "../app/AppContext";
import { api } from "../desktop-api";
import { setDraftResearch } from "./useResearchDraft";

/** Research auto-enables web search. */
export async function toggleResearch(
  app: Pick<
    AppController,
    "active" | "draftWebSearch" | "setDraftWebSearch" | "notify" | "upsert"
  >,
  on: boolean,
  reason: string | undefined,
  canAutoEnableWebSearch = true,
) {
  const { active } = app;
  if (!on && reason) {
    app.notify(reason);
    return;
  }
  const autoEnableWebSearch =
    !on &&
    canAutoEnableWebSearch &&
    !(active ? active.webSearch : app.draftWebSearch);
  if (active) {
    app.upsert(await api.setConversationResearch(active.id, !on));
  } else {
    setDraftResearch(!on);
    if (autoEnableWebSearch) app.setDraftWebSearch(true);
  }
  if (autoEnableWebSearch)
    app.notify("Web search enabled automatically for Research");
}
