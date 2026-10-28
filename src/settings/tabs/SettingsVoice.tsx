import { Row, Toggle } from "../controls";
import { Dropdown } from "../Dropdown";
import {
  speechLanguages,
  setSpeechLanguage,
  setSpeechVoice,
  setSpeechRate,
} from "../../voice/speech";
import { Check } from "../../ui/glyphs";
import { VoiceMark } from "../voice-preview";
import { nearestSpeed, speedChoices } from "./General";
import {
  browserRecognitionAvailable,
  chooseBrowserRecognition,
} from "../../voice/browser-recognition";
import type { SpeechPreferences } from "../../voice/speech";

/** What SettingsVoice needs from General.tsx. */
export interface SettingsVoiceProps {
  browserChosen: boolean;
  prefs: SpeechPreferences;
  setHovered: React.Dispatch<React.SetStateAction<string | null>>;
  shown: SpeechSynthesisVoice[];
  voicePreview: {
    playing: string | null;
    preview: (name: string) => Promise<void>;
    stop: () => void;
  };
}

export function SettingsVoice({
  browserChosen,
  prefs,
  setHovered,
  shown,
  voicePreview,
}: SettingsVoiceProps) {
  return (
    <div className="settings-voice">
      <Row label="Language">
        <Dropdown
          label="Language"
          value={prefs.language}
          options={speechLanguages}
          onChange={setSpeechLanguage}
        />
      </Row>
      <Row label="Style">
        <Dropdown
          label="Style"
          value={shown.some((v) => v.name === prefs.voice) ? prefs.voice : ""}
          options={[
            { value: "", label: "Browser default" },
            ...shown.map((voice) => ({
              value: voice.name,
              label: voice.name,
            })),
          ]}
          onChange={(name) => {
            voicePreview.stop();
            setSpeechVoice(name);
          }}
          // Closing the list stops a preview.
          onOpenChange={(open) => !open && setHovered(null)}
          trailing={(option, { selected, active }) =>
            option.value === "" ? (
              selected && (
                <Check className="check" size={18} strokeWidth={1.5} />
              )
            ) : (
              <span
                className={`voice-preview-cell${selected ? " selected" : ""}${active ? " lit" : ""}${voicePreview.playing === option.value ? " playing" : ""}`}
                onMouseEnter={() => setHovered(option.value)}
                onMouseLeave={() =>
                  setHovered((name) => (name === option.value ? null : name))
                }
              >
                <VoiceMark playing={voicePreview.playing === option.value} />
                {selected && (
                  <Check className="check" size={18} strokeWidth={1.5} />
                )}
              </span>
            )
          }
        />
      </Row>
      <Row label="Speed">
        <Dropdown
          label="Speed"
          value={String(nearestSpeed(prefs.rate))}
          options={speedChoices.map(({ rate, label }) => ({
            value: String(rate),
            label,
          }))}
          onChange={(value) => setSpeechRate(Number(value))}
        />
      </Row>
      {/* Claudex's own row, after the original's three. */}
      {browserRecognitionAvailable() && (
        <Row
          label="Speech recognition"
          description="Use this browser's speech recognition where Claudex can't transcribe. The browser sends what you say to its own speech service (Google's, in Chrome)."
        >
          <Toggle
            label="Speech recognition"
            checked={browserChosen}
            onChange={chooseBrowserRecognition}
          />
        </Row>
      )}
    </div>
  );
}
