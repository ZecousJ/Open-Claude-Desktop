import {
  connectorConfigurationError,
  type ConnectorUrlConfiguration,
} from "./connector-url-configuration";

export interface DirectorySubmissionInput extends ConnectorUrlConfiguration {
  id?: string;
  kind: "plugin" | "mcp";
  name: string;
  slug: string;
  url: string;
  description: string;
  examples: string;
  email: string;
  license: string;
  termsAcknowledged: boolean;
  toolsVerified: boolean;
  serverName?: string;
  author?: string;
  supportUrl?: string;
  documentationUrl?: string;
  isAuthless?: boolean;
  tools: string[];
}

export interface DirectorySubmission extends DirectorySubmissionInput {
  id: string;
  status: "draft" | "submitted" | "in_review" | "approved" | "rejected";
  reviewerNote: string;
  updatedAt: number;
}

export interface DirectoryCuration {
  topic?: string;
  /** Optional published metadata supplied by directory reviewers. */
  publisherUrl?: string;
  supportUrl?: string;
  categories?: string[];
  privacyPolicyUrl?: string;
  iconUrl?: string;
  relatedIds?: string[];
  isTrending?: boolean;
  isNew?: boolean;
  inChatUi?: boolean;
  popular?: boolean;
  featured?: {
    title: string;
    subtitle: string;
    curator?: string;
    /** Published directory identities, in the reviewer's chosen display order. */
    memberIds?: string[];
  };
}

export interface ApprovedDirectoryEntry extends ConnectorUrlConfiguration {
  id: string;
  kind: "plugin" | "mcp";
  name: string;
  /** The plugin's name in its marketplace (older services leave it out). */
  slug?: string;
  description: string;
  url: string;
  added: string;
  author?: string;
  supportUrl?: string;
  documentationUrl?: string;
  isAuthless?: boolean;
  tools?: string[];
  curation?: DirectoryCuration;
}

export const directorySubmissionStatusLabels: Record<
  DirectorySubmission["status"],
  string
> = {
  draft: "Draft",
  submitted: "Submitted and pending review",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

export const directorySubmissionSteps = [
  "Introduction",
  "Plugin information",
  "Submission details",
] as const;

export function directorySubmissionReady(input: DirectorySubmissionInput) {
  if (input.kind === "mcp" && connectorConfigurationError(input, input.url))
    return false;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  const slug =
    input.slug ||
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  return !!(
    input.termsAcknowledged &&
    input.name.trim() &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    input.description.trim() &&
    input.email.includes("@") &&
    (input.kind !== "mcp" || (input.toolsVerified && input.tools.length))
  );
}
