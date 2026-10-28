import type {
  DirectorySubmission,
  DirectorySubmissionInput,
  ApprovedDirectoryEntry,
} from "../../shared/directory-submissions";

export type DirectoryRequest = (
  route: string,
  init?: { method?: string; body?: unknown },
) => Promise<unknown>;

export class DirectorySubmissions {
  constructor(private readonly request: DirectoryRequest) {}

  async list(): Promise<DirectorySubmission[]> {
    return (await this.request(
      "/claudex/directory/submissions",
    )) as DirectorySubmission[];
  }

  async directory(): Promise<ApprovedDirectoryEntry[]> {
    return (await this.request(
      "/claudex/directory",
    )) as ApprovedDirectoryEntry[];
  }

  async save(
    input: DirectorySubmissionInput,
    submit: boolean,
  ): Promise<DirectorySubmission> {
    return (await this.request(
      `/claudex/directory/submissions${input.id ? `/${encodeURIComponent(input.id)}` : ""}`,
      {
        method: input.id ? "PUT" : "POST",
        body: { input, submit },
      },
    )) as DirectorySubmission;
  }

  async delete(id: string): Promise<void> {
    await this.request(
      `/claudex/directory/submissions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
