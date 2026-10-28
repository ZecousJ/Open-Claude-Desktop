import { X } from "../ui/glyphs";
import { formatText } from "../i18n";

/**
 * Long pasted text kept as an attachment: a 120px card with the text's first
 * lines faded out and a PASTED label. The remove button shows on hover and
 * keyboard focus.
 */
export function PastedCard({
  text,
  name,
  onRemove,
  attachmentId,
  restored,
  badge = "Pasted",
  title,
}: {
  /** The pasted text; only the first lines are shown. */
  text?: string;
  name: string;
  onRemove?: () => void;
  /** In the composer: the attachment's id, for its enter and exit motion. */
  attachmentId?: string;
  /** Shown again (another draft opened), so it does not animate in. */
  restored?: boolean;
  /** The label under the text; an excerpt from a terminal says "Excerpt". */
  badge?: string;
  /** Tooltip, e.g. the terminal an excerpt came from. */
  title?: string;
}) {
  return (
    <div
      className="pasted-card"
      data-attachment={attachmentId}
      data-restored={restored || undefined}
      title={title}
    >
      <p className="pasted-card-text" aria-hidden={!text}>
        {(text ?? "").slice(0, 400)}
      </p>
      <span className="pasted-card-label">{badge}</span>
      <span className="sr-only">{name}</span>
      {onRemove && (
        <button
          className="attachment-remove"
          aria-label={formatText("Remove {name}", { name })}
          onClick={onRemove}
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
