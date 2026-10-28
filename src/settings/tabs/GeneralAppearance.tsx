import { Section, Row, Segmented } from "../controls";
import type { Theme, ChatFont, Settings } from "../../../shared/types";
import { ThemeGlyph } from "../theme-glyphs";
import { Dropdown } from "../Dropdown";
import { serif, sans, system, dyslexia, TranscriptAppearance } from "./General";
import { Suspense } from "react";

/** What GeneralAppearance needs from General.tsx. */
export interface GeneralPart1Props {
  fontLabels: { serif: string; sans: string };
  save: (
    patch: Partial<Settings>,
    failure?: string | undefined,
    onFailure?: ((error: unknown) => void) | undefined,
  ) => void | Promise<boolean>;
  settings: Settings;
}

export function GeneralAppearance({
  fontLabels,
  save,
  settings,
}: GeneralPart1Props) {
  return (
    <Section title="Appearance">
      <Row label="Theme">
        <Segmented<Theme>
          label="Theme"
          value={settings.theme}
          onChange={(theme) => save({ theme })}
          options={[
            {
              value: "system",
              label: "System",
              icon: <ThemeGlyph name="Computer" />,
            },
            {
              value: "light",
              label: "Light",
              icon: <ThemeGlyph name="Sun" />,
            },
            {
              value: "dark",
              label: "Dark",
              icon: <ThemeGlyph name="Moon" />,
            },
          ]}
        />
      </Row>
      <Row label="Chat font">
        <Dropdown<ChatFont>
          label="Chat font"
          // Mode=select, popupClassName=w-56.
          menuWidth={224}
          highlightSelectedOnOpen
          value={settings.chatFont ?? "serif"}
          onChange={(chatFont) => save({ chatFont })}
          options={[
            { value: "serif", label: fontLabels.serif, style: serif },
            { value: "sans", label: fontLabels.sans, style: sans },
            { value: "system", label: "System", style: system },
            // Atkinson Hyperlegible Next sits behind a feature gate in the
            // original and is not offered here.
            { value: "dyslexia", label: "OpenDyslexic", style: dyslexia },
          ]}
        />
      </Row>
      <Suspense fallback={null}>
        <TranscriptAppearance settings={settings} save={save} />
      </Suspense>
      <Row
        label="Motion"
        description="Reduce animation in streaming responses and other interface elements."
      >
        <Segmented
          label="Motion"
          value={settings.motion ?? "system"}
          onChange={(motion) => save({ motion })}
          options={[
            { value: "system", label: "System" },
            { value: "reduced", label: "Reduced" },
          ]}
        />
      </Row>
    </Section>
  );
}
