import { Section, Row, Toggle } from "../controls";
import { BranchPrefixField } from "./ClaudeCodeSections";
import { preference } from "../../../shared/settings-extras";
import { surface } from "../../../shared/host";
import type { Settings } from "../../../shared/types";

/** What ClaudeCodePullRequests needs from ClaudeCode.tsx. */
export interface ClaudeCodePart3Props {
  save: (
    patch: Partial<Settings>,
    failure?: string | undefined,
    onFailure?: ((error: unknown) => void) | undefined,
  ) => void | Promise<boolean>;
  settings: Settings;
}

export function ClaudeCodePullRequests({
  save,
  settings,
}: ClaudeCodePart3Props) {
  return (
    <Section title="Pull requests">
      <Row
        label="Branch prefix"
        description="Prefix added to branch names for both local and cloud sessions."
      >
        <BranchPrefixField settings={settings} save={save} />
      </Row>
      <Row
        label="Create pull requests automatically"
        description="When Claudex pushes changes to a branch, it automatically opens a pull request without asking first. Applies to cloud sessions only."
      >
        <Toggle
          label="Create pull requests automatically"
          checked={preference(settings, "prAutoCreate")}
          onChange={(prAutoCreate) => save({ prAutoCreate })}
        />
      </Row>
      {/* Indented under it while it is on. */}
      {preference(settings, "prAutoCreate") && (
        <div className="desktop-subrow desktop-subrow-ps6">
          <Row
            label="Create as draft"
            description="Open auto-created pull requests as drafts instead of ready for review."
          >
            <Toggle
              label="Create as draft"
              checked={preference(settings, "prAutoCreateDraft")}
              onChange={(prAutoCreateDraft) => save({ prAutoCreateDraft })}
            />
          </Row>
        </div>
      )}
      <Row
        label="Auto-fix pull requests"
        description="When you create a pull request, Claudex automatically monitors it for CI failures and review comments, then responds proactively. Claudex may post comments on your behalf."
      >
        {/* Native gh and the authenticated cloud service share the watcher. */}
        <Toggle
          label="Auto-fix pull requests"
          checked={preference(settings, "prAutoFix")}
          onChange={(prAutoFix: boolean) => save({ prAutoFix })}
        />
      </Row>
      {/* Archiving here only archives; Claudex sessions have no worktree to
         remove. */}
      {surface !== "web" && (
        <>
          <Row
            label="Auto-archive after PR merge or close"
            description="Automatically archive desktop sessions when the associated pull request is merged or closed."
          >
            <Toggle
              label="Auto-archive after PR merge or close"
              checked={preference(settings, "prAutoArchive")}
              onChange={(prAutoArchive) => save({ prAutoArchive })}
            />
          </Row>
          <Row
            label="Open pull requests in browser"
            description="Open pull request links in your default browser instead of the in-app viewer."
          >
            <Toggle
              label="Open pull requests in browser"
              checked={preference(settings, "prOpenInBrowser")}
              onChange={(prOpenInBrowser) => save({ prOpenInBrowser })}
            />
          </Row>
        </>
      )}
    </Section>
  );
}
