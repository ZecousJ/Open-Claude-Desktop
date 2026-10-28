import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  IqCheck,
  IqExample,
  IqGroup,
} from "../../../shared/service-status-api";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { t, tf } from "../../i18n";
import { surface } from "../../../shared/host";

/**
 * 智商检测: every hour the service asks a model for an HTML page with an SVG
 * animation of a pelican riding a bicycle; each check is a card with the page
 * it wrote and when. The page runs sandboxed with its own scripts, only once
 * the card is on screen: on the desktop from createArtifactPreview
 * (claudex-preview:, its own policy), on the web as the frame's srcdoc (a
 * signed preview address stayed blank in a frame). The check runs in more than
 * one group; a segmented control in the head switches the records.
 */
export function IqChecks({
  checks,
  groups,
  examples,
}: {
  checks: IqCheck[];
  groups: IqGroup[];
  examples: IqExample[];
}) {
  const [chosen, setChosen] = useState("");
  const group = groups.find((g) => g.key === chosen) ?? groups[0];
  const shown = group ? group.checks : checks;
  if (!shown.length && !examples.length && groups.length < 2) return null;
  return (
    <section className="st-card" aria-labelledby="st-iq">
      <div className="st-card-head">
        <h2 id="st-iq">{t("GPT IQ check")}</h2>
        {groups.length > 1 && group && (
          <SegmentedControl
            className="st-iq-groups"
            label={t("IQ check group")}
            value={group.key}
            segments={groups.map((g) => ({ value: g.key, label: g.name }))}
            onChange={setChosen}
          />
        )}
      </div>
      {examples.length > 0 && (
        <div className="st-iq-part st-iq-examples">
          <h3 className="st-iq-title">{t("Reference examples")}</h3>
          <div className="st-iq-grid">
            {examples.map((example) => (
              <IqCard
                key={example.kind}
                html={example.html}
                kind={example.kind}
                caption={
                  example.kind === "normal"
                    ? t("IQ check: normal")
                    : t("IQ check: dumbed down")
                }
              />
            ))}
          </div>
        </div>
      )}
      <div className="st-iq-part">
        <h3>{t("Check records")}</h3>
        <p className="st-iq-about">
          {t("An automatic pelican-drawing IQ check every hour.")}
        </p>
        {shown.length > 0 && (
          <div className="st-iq-grid">
            {shown.map((check) => (
              <IqCard
                key={check.id}
                html={check.status === "ok" ? check.html : ""}
                caption={tf("Checked {time}", {
                  time: timeText(check.startedAt),
                })}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The page is asked for at 800×600 (4:3) and shown whole: laid out at that
 * size, scaled to the card, never scrolled.
 */
const pageWidth = 800;
const pageHeight = 600;
const fitted = (html: string) => {
  const style = "<style>html,body{overflow:hidden!important}</style>";
  const head = /<head[^>]*>/i.exec(html);
  return head
    ? html.slice(0, head.index + head[0].length) +
        style +
        html.slice(head.index + head[0].length)
    : style + html;
};

const timeText = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function IqCard({
  html,
  caption,
  kind,
}: {
  html: string;
  caption: ReactNode;
  /** An example's verdict: its card takes that colour. */
  kind?: "normal" | "degraded";
}) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / pageWidth);
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el || visible) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [visible]);
  const inline = surface !== "desktop";
  useEffect(() => {
    if (!visible || !html || inline) return;
    let disposed = false;
    let made: string | undefined;
    void window.desktop
      .createArtifactPreview(fitted(html))
      .then((value) => {
        if (disposed) {
          void window.desktop.releaseArtifactPreview(value).catch(() => {});
          return;
        }
        made = value;
        setUrl(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (made)
        void window.desktop.releaseArtifactPreview(made).catch(() => {});
    };
  }, [visible, html, inline]);
  return (
    <figure className={kind ? `st-iq-card ${kind}` : "st-iq-card"}>
      <div className="st-iq-frame" ref={box}>
        {html ? (
          (url || (visible && inline)) && (
            <iframe
              src={inline ? undefined : url}
              srcDoc={inline ? fitted(html) : undefined}
              scrolling="no"
              style={{
                width: pageWidth,
                height: pageHeight,
                transform: `scale(${scale})`,
              }}
              title={typeof caption === "string" ? caption : t("GPT IQ check")}
              sandbox="allow-scripts"
            />
          )
        ) : (
          <span className="st-iq-missing">{t("No page this time")}</span>
        )}
      </div>
      <figcaption className="st-iq-meta">{caption}</figcaption>
    </figure>
  );
}
