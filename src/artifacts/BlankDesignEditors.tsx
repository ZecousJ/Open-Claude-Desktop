import { ArtifactPreview } from "./ArtifactPreview";
import { useRef, useState } from "react";
import {
  Plus,
  Table2 as Table,
  Image as ImageIcon,
  Type,
  Square,
  MousePointer2,
  Hand,
} from "../ui/glyphs";
import {
  editorMarkup,
  parseBlankContent,
  serializeBlankContent,
} from "./blank-artifact-model";
import { t, tc } from "../i18n";
import "./blank-artifact.css";
import { Editable, table, Tool, imageFile } from "./BlankArtifactEditor";
import type { Props, EditableHandle } from "./BlankArtifactEditor";

export function SlidesEditor({
  content,
  onChange,
  readOnly,
  status,
  onError,
}: Props) {
  const doc = parseBlankContent(content),
    root = doc.querySelector("[data-claudex-slides]") ?? doc.body,
    slides = [...root.querySelectorAll<HTMLElement>(":scope > section")];
  const [index, setIndex] = useState(0),
    [zoom, setZoom] = useState(100),
    [properties, setProperties] = useState(false);
  const handle = useRef<EditableHandle | null>(null),
    image = useRef<HTMLInputElement>(null);
  const active = slides[Math.min(index, slides.length - 1)];
  const add = () => {
    const slide = doc.createElement("section");
    slide.dataset.slide = String(slides.length + 1);
    slide.innerHTML = "<h1><br></h1><p><br></p>";
    root.append(slide);
    onChange(serializeBlankContent(doc));
    setIndex(slides.length);
  };
  return (
    <div className="blank-slides">
      <div
        className="blank-canvas-toolbar"
        role="toolbar"
        aria-label={t("Presentation actions")}
      >
        <div className="blank-tool-island">
          <Tool
            label="Text"
            disabled={readOnly || !active}
            onClick={() => handle.current?.insert("<p>Text</p>")}
          >
            <Type size={14} />
          </Tool>
          <Tool
            label="Image or video"
            disabled={readOnly || !active}
            onClick={() =>
              imageFile(
                image.current,
                (html) => handle.current?.insert(html),
                onError,
              )
            }
          >
            <ImageIcon size={14} />
          </Tool>
          <Tool
            label="Table"
            disabled={readOnly || !active}
            onClick={() => handle.current?.insert(table)}
          >
            <Table size={14} />
          </Tool>
          <Tool
            label="Shapes"
            disabled={readOnly || !active}
            onClick={() =>
              handle.current?.insert(
                '<svg viewBox="0 0 160 100" width="160" height="100"><rect width="160" height="100" fill="#c96442"/></svg>',
              )
            }
          >
            <Square size={14} />
          </Tool>
        </div>
        <span className="blank-save-status">{status}</span>
        <div className="blank-tool-island">
          <Tool
            label="Properties"
            pressed={properties}
            onClick={() => setProperties(!properties)}
          >
            <Table size={14} />
          </Tool>
          <select
            aria-label={t("Zoom")}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            {[50, 75, 100, 125].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>
        </div>
      </div>
      <input
        ref={image}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
      />
      {!slides.length ? (
        <div className="blank-canvas-empty">
          <span aria-hidden="true" className="blank-empty-slides">
            ▱
          </span>
          <p>
            {t(
              "This presentation has no slides yet. Add one, or let Claudex add some.",
            )}
          </p>
          <button type="button" disabled={readOnly} onClick={add}>
            {t("Add slide")}
          </button>
        </div>
      ) : (
        <div className="blank-slides-workspace">
          <nav aria-label={t("Slides")}>
            {slides.map((slide, i) => (
              <button
                key={i}
                className={i === index ? "selected" : ""}
                onClick={() => setIndex(i)}
              >
                {i + 1}
                <span>{slide.textContent?.slice(0, 35)}</span>
              </button>
            ))}
            <button
              disabled={readOnly}
              onClick={add}
              aria-label={t("Add slide")}
            >
              <Plus size={15} />
            </button>
          </nav>
          <div className="blank-slide-scroll">
            <div
              className="blank-slide-page"
              style={{ width: `${Math.min(100, zoom)}%` }}
            >
              <Editable
                key={Math.min(index, slides.length - 1)}
                handle={handle}
                label="Slide content"
                html={active?.innerHTML ?? ""}
                readOnly={readOnly}
                onChange={(html) => {
                  active.innerHTML = html;
                  onChange(serializeBlankContent(doc));
                }}
              />
            </div>
          </div>
          {properties && active && (
            <aside className="blank-properties">
              <label>
                {tc("fill", "Background")}
                <input
                  type="color"
                  value={active.style.backgroundColor || "#ffffff"}
                  disabled={readOnly}
                  onChange={(e) => {
                    active.style.backgroundColor = e.target.value;
                    onChange(serializeBlankContent(doc));
                  }}
                />
              </label>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

export function DesignEditor({ content, onChange, readOnly, status }: Props) {
  const parsed = new DOMParser().parseFromString(content, "image/svg+xml"),
    root = parsed.documentElement;
  const valid =
      root.localName === "svg" && !parsed.querySelector("parsererror"),
    boards = valid
      ? [...root.querySelectorAll<SVGGElement>("g[data-artboard]")]
      : [];
  const [tool, setTool] = useState("select"),
    [zoom, setZoom] = useState(50),
    [properties, setProperties] = useState(false),
    [selected, setSelected] = useState<string>();
  const save = () =>
    onChange(new XMLSerializer().serializeToString(root) + "\n");
  const add = (kind: string) => {
    if (readOnly || !valid) return;
    const element = parsed.createElementNS(
      "http://www.w3.org/2000/svg",
      kind === "artboard" ? "g" : kind === "text" ? "text" : "rect",
    );
    const id = crypto.randomUUID();
    element.setAttribute("data-element-id", id);
    if (kind === "artboard") {
      element.setAttribute("data-artboard", String(boards.length + 1));
      element.setAttribute(
        "transform",
        `translate(${40 + boards.length * 40} ${40 + boards.length * 40})`,
      );
      element.innerHTML = '<rect width="800" height="600" fill="#fff"/>';
    } else {
      if (!boards.length) return;
      element.setAttribute("x", "80");
      element.setAttribute("y", "100");
      element.setAttribute("fill", kind === "text" ? "#202020" : "#c96442");
      if (kind === "text") {
        element.setAttribute("font-size", "28");
        element.textContent = "Text";
      } else {
        element.setAttribute("width", "200");
        element.setAttribute("height", "120");
      }
    }
    (kind === "artboard" ? root : boards[0]).append(element);
    setSelected(id);
    save();
  };
  const selectedElement = selected
    ? root.querySelector(`[data-element-id="${selected}"]`)
    : null;
  if (!valid)
    return (
      <div className="blank-editor-error">
        {t("This artifact cannot be edited as text.")}
      </div>
    );
  return (
    <div className="blank-design">
      <div
        className="blank-canvas-toolbar"
        role="toolbar"
        aria-label={t("Design actions")}
      >
        <div className="blank-tool-island">
          <span className="blank-page-label">{t("Page 1")}</span>
          <Tool
            label="Select"
            pressed={tool === "select"}
            onClick={() => setTool("select")}
          >
            <MousePointer2 size={14} />
          </Tool>
          <Tool
            label="Hand"
            pressed={tool === "hand"}
            onClick={() => setTool("hand")}
          >
            <Hand size={14} />
          </Tool>
          <Tool
            label="Text"
            disabled={readOnly || !boards.length}
            onClick={() => add("text")}
          >
            <Type size={14} />
          </Tool>
          <Tool
            label="Artboard"
            disabled={readOnly}
            onClick={() => add("artboard")}
          >
            <Plus size={14} />
          </Tool>
          <Tool
            label="Rectangle"
            disabled={readOnly || !boards.length}
            onClick={() => add("rect")}
          >
            <Square size={14} />
          </Tool>
        </div>
        <span className="blank-save-status">{status}</span>
        <div className="blank-tool-island">
          <Tool
            label="Properties"
            pressed={properties}
            onClick={() => setProperties(!properties)}
          >
            <Table size={14} />
          </Tool>
          <select
            aria-label={t("Zoom")}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            {[25, 50, 75, 100].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>
        </div>
      </div>
      {!boards.length ? (
        <div className="blank-canvas-empty">
          <p>
            {t(
              "This canvas has no artboards yet. Add one, or let Claudex add some.",
            )}
          </p>
          <button disabled={readOnly} onClick={() => add("artboard")}>
            {t("Add an artboard")}
          </button>
        </div>
      ) : (
        <div className="blank-design-workspace">
          <div
            className="blank-design-canvas"
            style={{ cursor: tool === "hand" ? "grab" : "default" }}
            onPointerDown={(event) => {
              if (tool !== "hand") return;
              const node = event.currentTarget,
                startX = event.clientX,
                startY = event.clientY,
                left = node.scrollLeft,
                top = node.scrollTop;
              node.setPointerCapture(event.pointerId);
              node.onpointermove = (e) => {
                node.scrollLeft = left - (e.clientX - startX);
                node.scrollTop = top - (e.clientY - startY);
              };
              node.onpointerup = () => {
                node.onpointermove = null;
                node.releasePointerCapture(event.pointerId);
              };
            }}
            onClick={(event) => {
              if (tool !== "select") return;
              const element = (event.target as Element).closest(
                "[data-element-id]",
              );
              setSelected(
                element?.getAttribute("data-element-id") ?? undefined,
              );
            }}
          >
            <div
              style={{
                width: `${(1600 * zoom) / 100}px`,
                height: `${(1200 * zoom) / 100}px`,
              }}
              dangerouslySetInnerHTML={{ __html: editorMarkup(content) }}
            />
          </div>
          {properties && (
            <aside className="blank-properties">
              {selectedElement ? (
                <>
                  <label>
                    {t("Fill")}
                    <input
                      type="color"
                      disabled={readOnly}
                      value={selectedElement.getAttribute("fill") ?? "#c96442"}
                      onChange={(event) => {
                        selectedElement.setAttribute(
                          "fill",
                          event.target.value,
                        );
                        save();
                      }}
                    />
                  </label>
                  {selectedElement.localName === "text" && (
                    <label>
                      {t("Text")}
                      <input
                        value={selectedElement.textContent ?? ""}
                        disabled={readOnly}
                        onChange={(event) => {
                          selectedElement.textContent = event.target.value;
                          save();
                        }}
                      />
                    </label>
                  )}
                  <button
                    disabled={readOnly}
                    onClick={() => {
                      selectedElement.remove();
                      setSelected(undefined);
                      save();
                    }}
                  >
                    {t("Delete")}
                  </button>
                </>
              ) : (
                <p>{t("Select an object")}</p>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

export function DashboardEditor({ artifact, content, status, onError }: Props) {
  const [source, setSource] = useState(false);
  const doc = parseBlankContent(content),
    empty =
      !doc.body.textContent?.trim() &&
      !doc.body.querySelector("svg,img,canvas,table,iframe");
  return (
    <div className="blank-dashboard">
      <div
        className="blank-dashboard-toolbar"
        role="radiogroup"
        aria-label={t("Dashboard view")}
      >
        <span className="blank-save-status">{status}</span>
        <button
          role="radio"
          aria-checked={!source}
          aria-label={t("Use the page")}
          title={t("Use the page")}
          onClick={() => setSource(false)}
        >
          <MousePointer2 size={14} />
        </button>
        <button
          role="radio"
          aria-checked={source}
          aria-label={t("See where numbers come from")}
          title={t("See where numbers come from")}
          onClick={() => setSource(true)}
        >
          <Table size={14} />
        </button>
      </div>
      {source ? (
        <pre className="blank-dashboard-source">{content}</pre>
      ) : empty ? (
        <div className="blank-canvas-empty">
          {t("Nothing on this dashboard yet")}
        </div>
      ) : (
        <ArtifactPreview
          artifact={{ ...artifact, content }}
          refresh={0}
          onError={onError}
          onDownload={() => {}}
        />
      )}
    </div>
  );
}
