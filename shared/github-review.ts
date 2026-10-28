export type GitHubReviewRequest = {
  repository: string;
  number: number;
} & (
  | { action: "files" | "timeline" | "comments" | "checks" | "threads" }
  | { action: "resolve" | "threadReply"; threadId: string; body?: string }
  | { action: "annotations" | "rerun"; checkRunId: number }
  | {
      action: "comment";
      commitSha: string;
      path: string;
      line: number;
      startLine?: number;
      side?: "LEFT" | "RIGHT";
      body: string;
    }
  | { action: "reply"; commentId: number; body: string }
  | {
      action: "review";
      event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
      body?: string;
    }
);

export interface GitHubPrFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

export interface GitHubCheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  message: string;
  title?: string;
  raw_details?: string;
}

export interface GitHubTimelineEntry {
  id: number;
  event?: string;
  body?: string;
  state?: string;
  created_at?: string;
  user?: { login: string };
  actor?: { login: string };
  html_url?: string;
}

export interface GitHubReviewResult {
  threads?: import("./github-api").GitHubReviewThread[];
  comment?: import("./github-api").GitHubReviewComment;
  files?: GitHubPrFile[];
  timeline?: GitHubTimelineEntry[];
  comments?: GitHubTimelineEntry[];
  checks?: GitHubCheckRun[];
  annotations?: GitHubCheckAnnotation[];
}
