import type { Settings } from "../../../shared/types";
import {
  preference,
  type TranscriptTextSize,
  type TranscriptWidth,
} from "../../../shared/settings-extras";
import { transcriptTextSize } from "../../transcript/transcript-text-size";
import type { TabProps } from "../context";
import { Row, Segmented } from "../controls";

/** General's appearance rows. */
export function TranscriptAppearance({
  settings,
  save,
}: {
  settings: Settings;
  save: TabProps["save"];
}) {
  return (
    <>
      {/* The live row has no description. */}
      <Row label="Transcript text size">
        <Segmented<TranscriptTextSize>
          label="Transcript text size"
          value={transcriptTextSize(settings)}
          options={[
            { value: "s", label: "Small" },
            { value: "m", label: "Medium" },
            { value: "l", label: "Large" },
          ]}
          onChange={(transcriptTextSize) => save({ transcriptTextSize })}
        />
      </Row>
      <Row
        label="Transcript width"
        description="Maximum width of the transcript and composer columns."
      >
        <Segmented<TranscriptWidth>
          label="Transcript width"
          value={preference(settings, "transcriptWidth")}
          options={[
            { value: "s", label: "Narrow" },
            { value: "m", label: "Medium" },
            { value: "l", label: "Wide" },
          ]}
          onChange={(transcriptWidth) => save({ transcriptWidth })}
        />
      </Row>
    </>
  );
}
