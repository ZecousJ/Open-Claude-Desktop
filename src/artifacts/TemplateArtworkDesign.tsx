import "./template-artwork.css";
import { Part, Cursor } from "./TemplateArtworkParts";

export function DesignArtwork() {
  return (
    <>
      <Part
        clip
        box={[42, 8, 40, 68, 6]}
        fill="var(--card-fill)"
        style={{
          boxShadow: "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
          "--card-wash": "color-mix(in srgb, #7663b8 12%, transparent)",
        }}
      >
        <Part box={[15, 4, 10, 2.5, 9999]} fill="var(--notch)" />
        <Part box={[5, 22, 30, 7, 0]}>
          <Part part="design-row-0" box={[0, 0, 30, 7, 0]}>
            <Part
              box={[0, 0, 7, 7, 9999]}
              fill="color-mix(in srgb, var(--ink) 62%, var(--ink-to))"
            />
            <Part box={[10, 2, 20, 3.5, 9999]} fill="var(--text-line)" />
            <Part
              part="design-row-0-select"
              hidden
              box={[-2, -2, 34, 11, 3]}
              style={{ boxShadow: "inset 0 0 0 1px var(--template-accent)" }}
            />
          </Part>
        </Part>
        <Part box={[5, 34, 30, 7, 0]}>
          <Part part="design-row-1" box={[0, 0, 30, 7, 0]}>
            <Part
              box={[0, 0, 7, 7, 9999]}
              fill="color-mix(in srgb, var(--ink) calc(30% + var(--tint-boost)), transparent)"
            />
            <Part box={[10, 2, 15, 3.5, 9999]} fill="var(--text-line)" />
          </Part>
        </Part>
        <Part part="design-row-2" hidden box={[5, 46, 30, 7, 0]}>
          <Part box={[0, 0, 30, 7, 0]}>
            <Part
              box={[0, 0, 7, 7, 9999]}
              fill="color-mix(in srgb, var(--ink) calc(30% + var(--tint-boost)), transparent)"
            >
              <Part
                part="design-row-2-avatar"
                hidden
                box={[0, 0, 7, 7, 9999]}
                fill="color-mix(in srgb, var(--ink) 62%, var(--ink-to))"
              />
            </Part>
            <Part box={[10, 2, 18, 3.5, 9999]} fill="var(--text-line)" />
          </Part>
        </Part>
        <Part
          box={[0, 58, 40, 10, 0]}
          fill="color-mix(in srgb, var(--ink) calc(12% + var(--tint-boost)), transparent)"
        />
        <Part box={[8.25, 61.24992, 3.5, 3.5, 9999]} fill="var(--tab)">
          <Part
            part="design-tab-0"
            box={[0, 0, 3.5, 3.5, 9999]}
            fill="color-mix(in srgb, var(--ink) 62%, var(--ink-to))"
          />
        </Part>
        <Part box={[18.24992, 61.24992, 3.5, 3.5, 9999]} fill="var(--tab)">
          <Part
            part="design-tab-1"
            hidden
            box={[0, 0, 3.5, 3.5, 9999]}
            fill="color-mix(in srgb, var(--ink) 62%, var(--ink-to))"
          />
        </Part>
        <Part box={[28.24992, 61.24992, 3.5, 3.5, 9999]} fill="var(--tab)" />
      </Part>
      <Part part="design-user" hidden style={{ left: 0, top: 0 }}>
        <Cursor />
      </Part>
      <Part part="design-cursor" hidden style={{ left: 0, top: 0 }}>
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

export function DashboardArtwork() {
  return (
    <>
      <Part
        clip
        box={[14, 14, 96, 56, 7]}
        fill="var(--card-fill)"
        style={{
          boxShadow: "0 0 0 1px var(--card-line), 0 2px 6px var(--card-wash)",
          "--card-wash": "color-mix(in srgb, var(--hue) 12%, transparent)",
        }}
      >
        <Part
          origin="bottom"
          box={[11, 34, 14, 12, 4]}
          fill="color-mix(in srgb, var(--ink) calc(26% + var(--tint-boost)), transparent)"
        />
        <Part
          origin="bottom"
          box={[31, 26, 14, 20, 4]}
          fill="color-mix(in srgb, var(--ink) calc(42% + var(--tint-boost)), transparent)"
        >
          <Part
            part="dashboard-hover-1"
            hidden
            box={[0, 0, 14, 20, 4]}
            fill="color-mix(in srgb, var(--ink) calc(60% + var(--tint-boost)), transparent)"
          />
        </Part>
        <Part
          part="dashboard-bar-2"
          origin="bottom"
          box={[51, 16, 14, 30, 4]}
          fill="color-mix(in srgb, var(--ink) 58%, var(--ink-to))"
        >
          <Part
            part="dashboard-held-2"
            hidden
            box={[-2, -2, 18, 34, 5]}
            style={{ boxShadow: "inset 0 0 0 1px var(--template-accent)" }}
          />
        </Part>
        <Part
          origin="bottom"
          box={[71, 30, 14, 16, 4]}
          fill="color-mix(in srgb, var(--ink) calc(34% + var(--tint-boost)), transparent)"
        >
          <Part
            part="dashboard-hover-3"
            hidden
            box={[0, 0, 14, 16, 4]}
            fill="color-mix(in srgb, var(--ink) calc(52% + var(--tint-boost)), transparent)"
          />
        </Part>
      </Part>
      <Part part="dashboard-user" hidden style={{ left: 0, top: 0 }}>
        <Cursor />
      </Part>
      <Part part="dashboard-cursor" hidden style={{ left: 0, top: 0 }}>
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
