export interface BackgroundTaskSuggestion {
  id: string;
  title: string;
  tldr?: string;
  prompt: string;
  cwd: string;
  createdAt: number;
}
export interface TaskBacklogItem {
  id: string;
  cwd: string;
  source: "dismissed" | "evicted" | "orphaned";
  title: string;
  tldr?: string;
  prompt: string;
  suggestedAt: number;
  filedAt: number;
}
export interface TaskBacklogAPI {
  getTaskBacklog(cwd: string, limit?: number): Promise<TaskBacklogItem[]>;
  dismissTaskBacklogItem(id: string, taken: boolean): Promise<boolean>;
  backgroundTaskSuggestions(
    conversationId: string,
  ): Promise<BackgroundTaskSuggestion[]>;
  launchBackgroundTaskSuggestion(
    conversationId: string,
    id: string,
  ): Promise<string | null>;
  popBackgroundTaskSuggestion(
    conversationId: string,
    launched: boolean,
  ): Promise<boolean>;
  popBackgroundTaskSuggestionById(
    conversationId: string,
    id: string,
    launched: boolean,
  ): Promise<boolean>;
}

export function appendTaskPrompt(draft: string, prompt: string) {
  return prompt.trim()
    ? draft.trim()
      ? `${draft}\n\n${prompt}`
      : prompt
    : draft;
}
