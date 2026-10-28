import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "../ui/glyphs";
import "./privacy-explanations.css";

export const privacyStorageNote =
  "Local sessions stay on this computer. Cloud sessions and synced data are stored by your Claudex service. Each model provider's data policies apply to requests it receives.";

// Claudex facts, not the reference product's privacy promises:
// docs/cloud-sync.md:19-25; electron/diagnostics.ts:2-15, 610-625;
// shared/diagnostics-api.ts:39-50; PrivacyTab's actual sharing managers.
export const privacyExplanations = [
  {
    title: "How we protect your data",
    points: [
      "Local sessions are stored on this computer. Cloud chats, projects and files are stored by your Claudex service.",
      "When your service supports reporting, Preferences below controls whether diagnostic and reply-feedback reports are sent.",
      "You can manage your shared chats and artifacts below when sharing is available.",
    ],
  },
  {
    title: "How we use your data",
    points: [
      "Your messages and attached content are sent to the model provider used for that session. That provider's data policies apply.",
      "Optional diagnostic reports contain error codes and known error descriptions, not prompts, replies or file paths.",
      "Reply feedback can include your rating, selected categories and comment. A conversation excerpt is included only when your service allows it and you choose to include it.",
      "Claudex does not set your model provider's training or retention policy.",
    ],
  },
] as const;

/** The observed 44px disclosures, with accurate Claudex data-flow copy. */
export function PrivacyExplanations() {
  return (
    <div className="privacy-explanations">
      {privacyExplanations.map(({ title, points }) => (
        <PrivacyExplanation key={title} title={title} points={points} />
      ))}
    </div>
  );
}

function PrivacyExplanation({
  title,
  points,
}: {
  title: string;
  points: readonly string[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const Caret = open ? ChevronDown : ChevronRight;
  return (
    <div className="privacy-explanation" data-setting={title}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        <Caret size={16} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className="privacy-explanation-body">
          <ul>
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
