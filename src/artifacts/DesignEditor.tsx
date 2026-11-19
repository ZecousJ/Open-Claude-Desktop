import { useState } from "react";
import {
  Hand,
  MousePointer2,
  Plus,
  Square,
  Table2 as Table,
  Type,
} from "../ui/glyphs";
import { t } from "../i18n";
import { editorMarkup } from "./blank-artifact-model";
import { Tool } from "./BlankArtifactTool";
import type { Props } from "./BlankArtifactEditor";
import "./blank-artifact.css";

type DesignEditorProps = Pick<
  Props,
  "content" | "onChange" | "readOnly" | "status"
>;

export function DesignEditor({
  content,
  onChange,
  readOnly,
  status,
}: DesignEditorProps) {
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
