import { Suspense, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import type { ChatEffort } from "../../../shared/types";
import {
  coworkInstructionsLimit,
  preference,
} from "../../../shared/settings-extras";
import { Button, Row, Section, Toggle } from "../controls";
import { Dropdown } from "../Dropdown";
import { formatText } from "../../i18n";
import type { TabProps } from "../context";
import { useLoaded } from "../pageControls";
import { effortChoices } from "./choices";
import { BrowserLinkPreferences } from "./BrowserLinkPreferences";
import "../desktop.css";
import "../original-rows.css";

/** Rows Settings search finds on this page. */
export { coworkLabels as searchLabels } from "./desktop-labels";
const CoworkMemoryFiles = lazyPiece(
  () => import("../../memory/CoworkMemoryFiles"),
  "CoworkMemoryFiles",
);

/**
 * Cowork. The sandbox and effort Cowork tasks use, the instructions added to
 * every task, and where Claudex keeps their files. Trusted folders now live
 * under General → Tasks. The local and trusted device lists live in Account.
 * The storage folder is the account's own and cannot be moved.
 */
export function CoworkTab({ settings, save, platform, onError }: TabProps) {
  const system = useLoaded(() => window.desktop.systemState(), onError);
  const instructions = preference(settings, "coworkInstructions");
  const [memoryOpen, setMemoryOpen] = useState(false);
  return (
    <>
      {/* R-1384/R-1385: the original's first rows. */}
      <Section>
        <Row label="Computer access" description="Cowork computer access">
          <Toggle
            label="Computer access"
            checked={preference(settings, "computerAccess")}
            onChange={(computerAccess) => save({ computerAccess })}
          />
        </Row>
      </Section>
      <Section>
        <Row
          label="Thinking effort"
          description="For Chat and Cowork, with models that support it."
        >
          <Dropdown<ChatEffort>
            label="Thinking effort"
            value={settings.effort}
            options={effortChoices}
            onChange={(effort) => save({ effort })}
          />
        </Row>
        <GlobalInstructions value={instructions} save={save} />
        <Row label="Memory">
          <Button size="regular" onClick={() => setMemoryOpen(true)}>
            View and manage memory
          </Button>
        </Row>
        {memoryOpen && (
          <Suspense fallback={null}>
            <CoworkMemoryFiles
              onClose={() => setMemoryOpen(false)}
              onError={onError}
            />
          </Suspense>
        )}
        {system.value && (
          <Row
            label="Cowork files"
            description={
              <>
                Files Cowork creates without a chosen folder, your artifacts and
                scheduled tasks are stored at{" "}
                <button
                  type="button"
                  className="desktop-path-link"
                  onClick={() =>
                    void window.desktop.revealDataFolder().catch(onError)
                  }
                >
                  {system.value.dataFolder}
                </button>
                .
              </>
            }
          />
        )}
      </Section>
      {/* Settings33: the same stored preferences and site editor as Code. */}
      <Section
        title="Browser"
        note="Preferences for the built-in browser in Code sessions."
      >
        <BrowserLinkPreferences settings={settings} save={save} />
      </Section>
    </>
  );
}

/**
 * Global instructions: a row with Edit that turns into a text box in the page,
 * with Cancel and Save ("Saving..." while it is kept). Over the limit it counts
 * the characters in red; a failed save says so and leaves the text for another
 * try.
 */
export function GlobalInstructions({
  value,
  save,
}: {
  value: string;
  save: TabProps["save"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const over = draft.length > coworkInstructionsLimit;
  if (!editing)
    return (
      <Row
        label="Global instructions"
        description="Instructions here apply to all Cowork sessions. Use this for preferences, conventions, or context that Claudex should always know."
      >
        <Button
          size="regular"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </Row>
    );
  return (
    <div className="cowork-instructions" data-setting="Global instructions">
      <p>
        Instructions here apply to all Cowork sessions. Use this for
        preferences, conventions, or context that Claudex should always know.
      </p>
      <textarea
        className="settings-textarea"
        aria-label="Global instructions"
        placeholder="Add instructions for Claudex to follow in all Cowork sessions..."
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div>
        {over && (
          <span role="status">
            {formatText("{count} / {max} characters", {
              count: draft.length.toLocaleString(),
              max: coworkInstructionsLimit.toLocaleString(),
            })}
          </span>
        )}
        <Button size="regular" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button
          size="regular"
          primary
          disabled={saving || over}
          onClick={async () => {
            setSaving(true);
            const kept = await save(
              { coworkInstructions: draft },
              "Failed to save instructions. You can try again.",
            );
            setSaving(false);
            if (kept !== false) setEditing(false);
          }}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
