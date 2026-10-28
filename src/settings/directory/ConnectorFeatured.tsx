import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "../../ui/glyphs";
import { formatText } from "../../i18n";
import { directoryGlyph } from "./icons";
import type { CatalogueConnector } from "../../../shared/connectors-catalogue";
import { connectorPublishedUrl } from "./connector-detail-model";

// Genuine bundle member tile layouts.
const clusterLayout = [
  [[83, 0]],
  [
    [70, -6],
    [54, 8],
  ],
  [
    [48, 10],
    [77, -5],
    [58, 6],
  ],
  [
    [45, -8],
    [70, 6],
    [51, -10],
    [61, 11],
  ],
  [
    [42, 11],
    [58, -8],
    [74, 5],
    [48, -11],
    [54, 8],
  ],
  [
    [45, -10],
    [54, 10],
    [70, -3],
    [48, 13],
    [58, -8],
    [51, 6],
  ],
  [
    [51, -10],
    [42, 11],
    [58, -3],
    [40, 14],
    [48, -13],
    [43, 6],
    [53, -5],
  ],
];

export default function ConnectorFeatured({
  entries,
  onOpen,
  variant = "settings",
  remoteIcons = true,
  featuredMembers,
}: {
  entries: CatalogueConnector[];
  onOpen?: (entry: CatalogueConnector) => void;
  variant?: "settings" | "customize";
  remoteIcons?: boolean;
  /** Published bundle members; callers must supply genuine curation membership. */
  featuredMembers?: (entry: CatalogueConnector) => CatalogueConnector[];
}) {
  // A source-backed bundle can supply its member records. A single featured
  // connector keeps its own logo; matching text alone never implies membership.
  const slides = entries.filter((entry) => entry.featured);
  const members = (entry: CatalogueConnector) =>
    (featuredMembers?.(entry) ?? [entry]).slice(0, 7);
  // O16 Do selects the published slide ID, keeping inventory refreshes
  // from silently changing the record behind an active carousel slide.
  const [selected, setSelected] = useState<string>();
  const [manual, setManual] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const queuedAdvance = useRef<string | undefined>(undefined);
  const selectedIndex = slides.findIndex((entry) => entry.id === selected);
  const active = selectedIndex < 0 ? 0 : selectedIndex;
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      const next =
        media.matches ||
        document.documentElement.dataset.motion === "reduced" ||
        document.documentElement.dataset.reduceMotion === "true";
      if (next) queuedAdvance.current = undefined;
      setReduced(next);
    };
    update();
    media.addEventListener("change", update);
    const observer =
      typeof MutationObserver === "function"
        ? new MutationObserver(update)
        : undefined;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion", "data-reduce-motion"],
    });
    return () => {
      media.removeEventListener("change", update);
      observer?.disconnect();
    };
  }, []);
  if (!slides.length) return null;
  const choose = (index: number) => {
    queuedAdvance.current = undefined;
    setManual(true);
    setSelected(slides[(index + slides.length) % slides.length].id);
  };
  const advance = () => setSelected(slides[(active + 1) % slides.length].id);
  // Source Do keeps an animation completion that races with hover/focus,
  // and consumes it once the last pause ends. A manual pick retires it.
  const resume = () => {
    const completed = queuedAdvance.current;
    queuedAdvance.current = undefined;
    if (
      completed === slides[active].id &&
      !manual &&
      !reduced &&
      document.visibilityState !== "hidden"
    )
      advance();
  };
  const content = (
    <div
      className={`connector-featured-slides${variant === "customize" ? " customize-connector-featured" : ""}`}
      aria-live={!manual && !hovered && !focused && !reduced ? "off" : "polite"}
    >
      {slides.map((entry, index) => {
        const Glyph = directoryGlyph(entry.icon);
        return (
          <section
            key={entry.id}
            role="group"
            aria-roledescription="slide"
            aria-label={entry.featured!.title}
            aria-hidden={index !== active}
            inert={index !== active}
            className={`connector-featured-slide ${index === active ? "active" : ""}`}
          >
            <div
              className={
                variant === "customize"
                  ? "customize-connector-featured-copy"
                  : undefined
              }
            >
              {entry.featured!.curator && (
                <small>
                  {formatText("Curated by {publisher}", {
                    publisher: entry.featured!.curator,
                  })}
                </small>
              )}
              <h2>{entry.featured!.title}</h2>
              <p>{entry.featured!.subtitle}</p>
            </div>
            {variant === "customize" ? (
              <span
                className="customize-connector-featured-cluster"
                aria-hidden="true"
              >
                {members(entry).map((member, memberIndex, group) => {
                  const Icon = directoryGlyph(member.icon);
                  const [size, offset] =
                    clusterLayout[group.length - 1][memberIndex];
                  const image =
                    remoteIcons && connectorPublishedUrl(member.iconUrl);
                  return (
                    <span
                      key={member.id}
                      style={{
                        width: size,
                        height: size,
                        transform: `translateY(${offset}px)`,
                      }}
                    >
                      {image ? (
                        <img
                          src={image}
                          alt=""
                          style={{
                            width: Math.round((size * 34) / 48),
                            height: Math.round((size * 34) / 48),
                          }}
                        />
                      ) : (
                        <Icon
                          size={Math.round((size * 26) / 48)}
                          strokeWidth={1.4}
                        />
                      )}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="connector-featured-tile" aria-hidden="true">
                <Glyph size={45} strokeWidth={1.4} />
              </span>
            )}
            <button
              type="button"
              className="directory-outline-button"
              disabled={variant === "customize" && !onOpen ? true : undefined}
              onClick={() => onOpen?.(entry)}
            >
              Explore
            </button>
          </section>
        );
      })}
    </div>
  );
  if (slides.length === 1) return content;
  return (
    <section
      aria-label="Featured"
      aria-roledescription="carousel"
      className={`connector-featured${variant === "customize" ? " customize-connector-featured-carousel" : ""}`}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        setHovered(false);
        if (!focused) resume();
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          if (!hovered) resume();
        }
      }}
    >
      <div className="connector-featured-frame">
        {content}
        <button
          type="button"
          className="connector-featured-previous"
          aria-label="Previous slide"
          onClick={() => choose(active - 1)}
        >
          <ChevronLeft size={20} />
        </button>
        <button
          type="button"
          className="connector-featured-next"
          aria-label="Next slide"
          onClick={() => choose(active + 1)}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div className="connector-featured-dots">
        {slides.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            aria-label={formatText("Show {title}", {
              title: entry.featured!.title,
            })}
            aria-current={active === index || undefined}
            onClick={() => choose(index)}
          >
            {active === index && (
              <span
                className={!manual && !reduced ? "auto" : undefined}
                style={{
                  animationPlayState: hovered || focused ? "paused" : "running",
                }}
                onAnimationEnd={() => {
                  if (
                    manual ||
                    reduced ||
                    document.visibilityState === "hidden"
                  )
                    return;
                  if (hovered || focused) queuedAdvance.current = entry.id;
                  else advance();
                }}
              />
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
