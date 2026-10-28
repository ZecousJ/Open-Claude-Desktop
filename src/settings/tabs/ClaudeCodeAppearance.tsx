import { Section, Row, Segmented } from "../controls";
import { t } from "../../i18n";
import type { InterfaceFont } from "../../../shared/settings-extras";
import { preference } from "../../../shared/settings-extras";
import type { TranscriptView } from "../../../shared/transcript-view";
import {
  transcriptViews,
  transcriptViewLabels,
} from "../../../shared/transcript-view";
import type { Settings } from "../../../shared/types";

/** What ClaudeCodeAppearance needs from ClaudeCode.tsx. */
export interface ClaudeCodePart1Props {
  save: (
    patch: Partial<Settings>,
    failure?: string | undefined,
    onFailure?: ((error: unknown) => void) | undefined,
  ) => void | Promise<boolean>;
  setFontLicenses: React.Dispatch<React.SetStateAction<boolean>>;
  settings: Settings;
}

export function ClaudeCodeAppearance({
  save,
  setFontLicenses,
  settings,
}: ClaudeCodePart1Props) {
  return (
    <Section title="Appearance">
      <Row
        label="Interface font"
        description={
          <>
            Font for the whole interface — menus, sidebars, and panels.{" "}
            <button
              type="button"
              className="font-license-link"
              aria-haspopup="dialog"
              onClick={() => setFontLicenses(true)}
            >
              {t("Font licenses")}
            </button>
          </>
        }
      >
        {/* Applied at once. */}
        <Segmented<InterfaceFont>
          label="Interface font"
          value={preference(settings, "interfaceFont")}
          options={[
            { value: "anthropic", label: "Claudex Sans" },
            { value: "system", label: "System" },
            { value: "dyslexic", label: "OpenDyslexic" },
          ]}
          onChange={(interfaceFont) => save({ interfaceFont })}
        />
      </Row>
      <Row
        label="Default transcript view"
        description="The view sessions open in. Picking a view from a session’s Transcript view menu changes only that session."
      >
        {/* A session's own pick (its Transcript view menu, Ctrl+O) wins
              over this (src/transcript-view). */}
        <Segmented<TranscriptView>
          label="Default transcript view"
          value={preference(settings, "defaultTranscriptView")}
          options={transcriptViews.map((value) => ({
            value,
            label: transcriptViewLabels[value],
          }))}
          onChange={(defaultTranscriptView) => save({ defaultTranscriptView })}
        />
      </Row>
    </Section>
  );
}
