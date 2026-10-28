import type { Attachment } from "../../shared/types";
import type { GitHubIssue } from "../../shared/github-api";
import { issueFileName, issueText } from "../../shared/github-issue";
import { api } from "../desktop-api";

/**
 * Import GitHub issue: reads the issue's text and keeps it as a text
 * attachment (`#12 Title.md`) of the next message. When the text can't be
 * read (the CLI or the connection failed after the list loaded), the
 * attachment holds the issue's address, as the original's does.
 */
export async function attachIssue(issue: GitHubIssue): Promise<Attachment> {
  const detail = await api
    .githubIssue({ repository: issue.repository, number: issue.number })
    .catch(() => null);
  return api.addAttachmentData(
    issueFileName(issue),
    new TextEncoder().encode(issueText(detail ?? issue)),
  );
}
