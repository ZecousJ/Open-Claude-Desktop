import "./template-artwork.css";
import { DesignArtwork, DashboardArtwork } from "./TemplateArtworkDesign";
import { Part, Cursor } from "./TemplateArtworkParts";

export type TemplateArtworkKind = "docs" | "slides" | "design" | "dashboard";
function Check() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 10"
      className="artifacts-template-check"
      fill="none"
      stroke="white"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.6 5.2L4.3 6.8L7.4 3.4" />
    </svg>
  );
}

function DocsArtwork() {
  return (
    <>
      <Part
        clip
        box={[38, 9, 48, 66, 5]}
        fill="var(--card-fill)"
        style={{
          boxShadow: "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
          "--card-wash": "color-mix(in srgb, var(--hue) 12%, transparent)",
        }}
      >
        <Part
          part="docs-head"
          box={[7, 7, 22, 5, 9999]}
          fill="color-mix(in srgb, var(--ink) 68%, var(--ink-to))"
        />
        <Part part="docs-cap" origin="bottom left" box={[7, 16, 9, 12, 0]}>
          <Part
            style={{
              fontSize: "13px",
              lineHeight: "12px",
              color: "color-mix(in srgb, var(--ink) 72%, var(--ink-to))",
              inset: 0,
              fontFamily: '"Claudex Reference Serif", Georgia, serif',
              textAlign: "center",
              fontWeight: 500,
              userSelect: "none",
            }}
          >
            A
          </Part>
        </Part>
        <Part
          part="docs-line-0"
          box={[18, 17, 23, 3.5, 9999]}
          fill="var(--text-line)"
        />
        <Part
          part="docs-line-1"
          box={[18, 23.5, 20, 3.5, 9999]}
          fill="var(--text-line)"
        />
        <Part
          part="docs-line-2"
          box={[7, 30, 34, 3.5, 9999]}
          fill="var(--text-line)"
        />
        <Part part="docs-check-row" box={[7, 37.5, 34, 5, 0]}>
          <Part
            box={[0, 0, 5, 5, 9999]}
            style={{
              boxShadow:
                "inset 0 0 0 1px color-mix(in srgb, var(--ink) calc(55% + var(--tint-boost)), transparent)",
            }}
          >
            <Part
              part="docs-check-fill"
              box={[0, 0, 5, 5, 9999]}
              fill="color-mix(in srgb, var(--ink) 72%, var(--ink-to))"
            >
              <Check />
            </Part>
          </Part>
          <Part box={[7, 0.75, 22, 3.5, 9999]} fill="var(--text-line)" />
        </Part>
        <Part
          part="docs-tail"
          box={[7, 46, 26, 3.5, 9999]}
          fill="var(--text-line)"
        />
        <Part
          part="docs-caret-user"
          hidden
          box={[7, 6, 1.5, 7, 1]}
          fill="var(--neutral)"
        />
        <Part
          part="docs-caret-claude"
          hidden
          box={[18, 15.5, 1.5, 6.5, 1]}
          fill="var(--template-clay)"
        />
      </Part>
      <Part
        part="docs-comment"
        hidden
        origin="top left"
        box={[76, 35, 21, 13, 3]}
        fill="var(--card-fill)"
        style={{
          boxShadow: "0 0 0 1px var(--card-line), 0 2px 6px rgb(0 0 0 / 14%)",
        }}
      >
        <Part box={[3, 3, 3, 3, 9999]} fill="var(--template-clay)" />
        <Part box={[8, 3.5, 8, 2, 9999]} fill="var(--text-line)" />
        <Part box={[3, 8, 12, 2, 9999]} fill="var(--text-line)" />
        <Part
          part="docs-comment-done"
          hidden
          box={[14, 6, 5, 5, 9999]}
          fill="var(--template-green)"
        >
          <Check />
        </Part>
      </Part>
      <Part part="docs-user" hidden style={{ left: 0, top: 0 }}>
        <Cursor />
      </Part>
      <Part part="docs-cursor" hidden style={{ left: 0, top: 0 }}>
        <Cursor color="var(--template-clay)" />
        <Part
          fill="var(--template-clay-emphasized)"
          style={{
            fontSize: "5.25px",
            lineHeight: "7px",
            left: 9,
            top: 10.5,
            whiteSpace: "nowrap",
            borderRadius: "1.5px 6px 6px 6px",
            padding: "1.5px 3.5px",
            fontWeight: 500,
            color: "white",
            boxShadow: "0 1px 2px rgb(0 0 0 / 20%)",
          }}
        >
          Claudex
        </Part>
      </Part>
    </>
  );
}

function SlidesArtwork() {
  return (
    <>
      <Part part="slides-C-in" hidden origin="center" box={[23, 45, 36, 22, 0]}>
        <Part part="slides-C" origin="center" box={[0, 0, 36, 22, 0]}>
          <Part
            clip
            box={[0, 0, 36, 22, 4]}
            fill="var(--card-fill)"
            style={{
              boxShadow:
                "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
              "--card-wash": "color-mix(in srgb, #b7791f 12%, transparent)",
            }}
          >
            <Part
              box={[5, 5, 14, 4, 9999]}
              fill="color-mix(in srgb, var(--ink) 68%, var(--ink-to))"
            />
            <Part box={[5, 12, 22, 3, 9999]} fill="var(--text-line)" />
          </Part>
        </Part>
      </Part>
      <Part part="slides-D-in" hidden origin="center" box={[65, 45, 36, 22, 0]}>
        <Part part="slides-D" origin="center" box={[0, 0, 36, 22, 0]}>
          <Part
            clip
            box={[0, 0, 36, 22, 4]}
            fill="var(--card-fill)"
            style={{
              boxShadow:
                "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
              "--card-wash": "color-mix(in srgb, #b7791f 12%, transparent)",
            }}
          >
            <Part
              box={[5, 5, 14, 4, 9999]}
              fill="color-mix(in srgb, var(--ink) 68%, var(--ink-to))"
            />
            <Part box={[5, 12, 22, 3, 9999]} fill="var(--text-line)" />
          </Part>
          <Part
            part="slides-D-held"
            hidden
            box={[-2, -2, 40, 26, 5]}
            style={{ boxShadow: "inset 0 0 0 1px var(--template-accent)" }}
          />
        </Part>
      </Part>
      <Part part="slides-B-in" hidden origin="center" box={[65, 17, 36, 22, 0]}>
        <Part part="slides-B" origin="center" box={[0, 0, 36, 22, 0]}>
          <Part
            clip
            box={[0, 0, 36, 22, 4]}
            fill="var(--card-fill)"
            style={{
              boxShadow:
                "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
              "--card-wash": "color-mix(in srgb, #b7791f 12%, transparent)",
            }}
          >
            <Part
              box={[5, 5, 14, 4, 9999]}
              fill="color-mix(in srgb, var(--ink) 68%, var(--ink-to))"
            />
            <Part box={[5, 12, 22, 3, 9999]} fill="var(--text-line)" />
          </Part>
          <Part
            part="slides-B-held"
            hidden
            box={[-2, -2, 40, 26, 5]}
            style={{ boxShadow: "inset 0 0 0 1px var(--template-accent)" }}
          />
        </Part>
      </Part>
      <Part part="slides-paper" origin="top left" box={[14, 14, 96, 56, 0]}>
        <Part
          part="slides-paper-card"
          clip
          box={[0, 0, 96, 56, 7]}
          fill="var(--card-fill)"
          style={{
            boxShadow: "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
            "--card-wash": "color-mix(in srgb, #b7791f 12%, transparent)",
          }}
        >
          <Part
            part="slides-title"
            box={[10, 10, 50, 9, 9999]}
            fill="color-mix(in srgb, var(--ink) 68%, var(--ink-to))"
          />
          <Part
            part="slides-line-0"
            box={[10, 26.5, 42, 6, 9999]}
            fill="var(--text-line)"
          />
          <Part
            part="slides-line-1"
            box={[10, 40, 32, 6, 9999]}
            fill="var(--text-line)"
          />
          <Part
            part="slides-pic"
            box={[60, 24, 26, 22, 4]}
            fill="color-mix(in srgb, var(--ink) calc(30% + var(--tint-boost)), transparent)"
          >
            <Part
              part="slides-pic-select"
              hidden
              box={[-2, -2, 30, 26, 5]}
              style={{ boxShadow: "inset 0 0 0 1px var(--template-accent)" }}
            />
          </Part>
          <Part
            part="slides-caret-user"
            hidden
            box={[10, 10.5, 1.5, 8, 1]}
            fill="var(--neutral)"
          />
          <Part
            part="slides-caret-claude"
            hidden
            box={[10, 25.5, 1.5, 8, 1]}
            fill="var(--template-clay)"
          />
          <Part part="slides-user-a" hidden style={{ left: 0, top: 0 }}>
            <Cursor />
          </Part>
          <Part part="slides-cursor-a" hidden style={{ left: 0, top: 0 }}>
            <Cursor color="var(--template-clay)" />
            <Part
              fill="var(--template-clay-emphasized)"
              style={{
                fontSize: "5.25px",
                lineHeight: "7px",
                left: 9,
                top: 10.5,
                whiteSpace: "nowrap",
                borderRadius: "1.5px 6px 6px 6px",
                padding: "1.5px 3.5px",
                fontWeight: 500,
                color: "white",
                boxShadow: "0 1px 2px rgb(0 0 0 / 20%)",
              }}
            >
              Claudex
            </Part>
          </Part>
        </Part>
      </Part>
      <Part part="slides-user" hidden style={{ left: 0, top: 0 }}>
        <Cursor />
      </Part>
      <Part part="slides-cursor" hidden style={{ left: 0, top: 0 }}>
        <Cursor color="var(--template-clay)" />
        <Part
          fill="var(--template-clay-emphasized)"
          style={{
            fontSize: "5.25px",
            lineHeight: "7px",
            left: 9,
            top: 10.5,
            whiteSpace: "nowrap",
            borderRadius: "1.5px 6px 6px 6px",
            padding: "1.5px 3.5px",
            fontWeight: 500,
            color: "white",
            boxShadow: "0 1px 2px rgb(0 0 0 / 20%)",
          }}
        >
          Claudex
        </Part>
      </Part>
    </>
  );
}

const artwork = {
  docs: DocsArtwork,
  slides: SlidesArtwork,
  design: DesignArtwork,
  dashboard: DashboardArtwork,
};
export function TemplateArtwork({ kind }: { kind: TemplateArtworkKind }) {
  const Artwork = artwork[kind];
  return (
    <span
      className="artifacts-make-art"
      data-artwork-kind={kind}
      aria-hidden="true"
    >
      <span className="artifacts-template-clip">
        <span className="artifacts-template-gradient" />
        <span className="artifacts-template-ink">
          <Artwork />
        </span>
      </span>
    </span>
  );
}
