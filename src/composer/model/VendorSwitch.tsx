import { Suspense, type CSSProperties } from "react";
import { lazyPiece } from "../../ui/lazy-piece";

// The makers' marks are long paths; they load with the first open menu.
const ProviderLogo = lazyPiece(
  () => import("../../collections/api/ProviderLogo"),
  "ProviderLogo",
);

/**
 * The makers' switch at the top of the model menu: their marks alone on a
 * track, the chosen one on a thumb that slides to it. Drawn like the composer's
 * Chat/Cowork switch: a white 5% track 1px around 26px segments, the thumb
 * white 10% with a 1px white 10% ring.
 */
export function VendorSwitch({
  vendors,
  selected,
  onSelect,
  onHover,
}: {
  vendors: { id: string; name: string }[];
  selected: string;
  onSelect: (id: string) => void;
  /** The pointer is over the switch, not over a row with a submenu. */
  onHover?: () => void;
}) {
  const index = Math.max(
    0,
    vendors.findIndex((v) => v.id === selected),
  );
  return (
    <div
      className="model-vendor-switch"
      role="radiogroup"
      aria-label="Model provider"
      onMouseEnter={onHover}
      style={
        {
          "--vendor-count": vendors.length,
          "--vendor-index": index,
        } as CSSProperties
      }
    >
      <span className="model-vendor-thumb" aria-hidden="true" />
      {vendors.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={v.id === selected}
          title={v.name}
          aria-label={v.name}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(v.id);
          }}
        >
          <Suspense fallback={<span style={{ width: 14, height: 14 }} />}>
            <ProviderLogo id={v.id} size={14} />
          </Suspense>
        </button>
      ))}
    </div>
  );
}
