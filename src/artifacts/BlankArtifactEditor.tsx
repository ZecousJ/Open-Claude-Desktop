import type { Artifact } from "../ui/ArtifactTypes";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Plus,
  Table2 as Table,
  Image as ImageIcon,
  ListChecks as CheckSquare,
  Maximize2,
} from "../ui/glyphs";
import type { ArtifactOutputKind } from "../../shared/artifact-output";
import {
  editorMarkup,
  parseBlankContent,
  serializeBlankContent,
} from "./blank-artifact-model";
import { t } from "../i18n";
import "./blank-artifact.css";
import {
  SlidesEditor,
  DesignEditor,
  DashboardEditor,
} from "./BlankDesignEditors";
export interface Props {
  artifact: Artifact;
  kind: ArtifactOutputKind;
  content: string;
  onChange(content: string): void;
  readOnly: boolean;
  status: ReactNode;
  onError(error: unknown): void;
}
export interface EditableHandle {
  insert(html: string): void;
  focus(): void;
}
/** A real editing surface. All pasted HTML is sanitized before insertion in
 * the host app; scripts in a generated dashboard run only in its iframe. */
export function Editable({
  html,
  onChange,
  label,
  readOnly,
  handle,
  className = "",
}: {
  html: string;
  onChange(html: string): void;
  label: string;
  readOnly: boolean;
  handle?: { current: EditableHandle | null };
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    range = useRef<Range | null>(null);
  const changed = () => {
    const element = ref.current;
    if (element) onChange(editorMarkup(element.innerHTML));
  };
  const remember = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && ref.current?.contains(selection.anchorNode))
      range.current = selection.getRangeAt(0).cloneRange();
  };
  const insert = (html: string) => {
    const element = ref.current;
    if (!element || readOnly) return;
    element.focus();
    const selection = window.getSelection();
    const saved = range.current;
    if (saved && element.contains(saved.commonAncestorContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(saved);
    }
    const selected = selection?.rangeCount
      ? selection.getRangeAt(0)
      : undefined;
    const template = document.createElement("template");
    template.innerHTML = editorMarkup(html);
    const tail = template.content.lastChild;
    if (selected && element.contains(selected.commonAncestorContainer)) {
      selected.deleteContents();
      selected.insertNode(template.content);
      if (tail) {
        selected.setStartAfter(tail);
        selected.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(selected);
      }
    } else element.append(template.content);
    remember();
    changed();
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) {
      const safe = editorMarkup(html);
      if (element.innerHTML !== safe) element.innerHTML = safe;
    }
  }, [html]);
  useLayoutEffect(() => {
    if (!handle) return;
    const api = { insert, focus: () => ref.current?.focus() };
    handle.current = api;
    return () => {
      if (handle.current === api) handle.current = null;
    };
  });
  return (
    <div
      ref={ref}
      className={`blank-editable ${className}`}
      role="textbox"
      aria-label={t(label)}
      aria-multiline="true"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      onInput={changed}
      onKeyUp={remember}
      onPointerUp={remember}
      onBlur={remember}
      onPaste={(event) => {
        event.preventDefault();
        insert(
          event.clipboardData.getData("text/html") ||
            escapeText(event.clipboardData.getData("text/plain")).replaceAll(
              "\n",
              "<br>",
            ),
        );
      }}
    />
  );
}
const escapeText = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export const table =
  "<table><tbody><tr><td><p><br></p></td><td><p><br></p></td></tr><tr><td><p><br></p></td><td><p><br></p></td></tr></tbody></table><p><br></p>";
export function Tool({
  label,
  children,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={t(label)}
      title={t(label)}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function imageFile(
  input: HTMLInputElement | null,
  onImage: (html: string) => void,
  onError: (error: unknown) => void,
) {
  if (!input) return;
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.type,
      ) ||
      file.size > 1_000_000
    ) {
      onError(
        new Error("Choose a PNG, JPEG, GIF or WebP image smaller than 1 MB."),
      );
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onImage(
        `<img src="${String(reader.result)}" alt="${escapeText(file.name)}">`,
      );
      input.value = "";
    };
    reader.onerror = () => onError(reader.error);
    reader.readAsDataURL(file);
  };
  input.click();
}
export function BlankArtifactEditor(props: Props) {
  if (props.kind === "docs") return <DocumentEditor {...props} />;
  if (props.kind === "slides") return <SlidesEditor {...props} />;
  if (props.kind === "design") return <DesignEditor {...props} />;
  return <DashboardEditor {...props} />;
}
function DocumentEditor({
  content,
  onChange,
  readOnly,
  status,
  onError,
}: Props) {
  const [tab, setTab] = useState(0),
    [wide, setWide] = useState(false);
  const handle = useRef<EditableHandle | null>(null),
    image = useRef<HTMLInputElement>(null);
  const doc = parseBlankContent(content);
  let body = doc.querySelector("[data-claudex-document]") ?? doc.body;
  let sections = [
    ...body.querySelectorAll<HTMLElement>(":scope > section[data-tab]"),
  ];
  if (!sections.length) {
    const section = doc.createElement("section");
    section.dataset.tab = "1";
    section.dataset.name = "Tab 1";
    section.innerHTML = body.innerHTML;
    body.replaceChildren(section);
    sections = [section];
  }
  const index = Math.min(tab, sections.length - 1),
    current = sections[index];
  const update = (html: string) => {
    current.innerHTML = editorMarkup(html);
    onChange(serializeBlankContent(doc));
  };
  return (
    <div className={`blank-document ${wide ? "wide" : ""}`}>
      <div
        className="blank-editor-toolbar"
        role="toolbar"
        aria-label={t("Document actions")}
      >
        <select
          aria-label={t("Tabs")}
          value={index}
          onChange={(event) => {
            if (event.target.value === "new") {
              const section = doc.createElement("section");
              section.dataset.tab = String(sections.length + 1);
              section.dataset.name = `Tab ${sections.length + 1}`;
              section.innerHTML = "<p><br></p>";
              body.append(section);
              onChange(serializeBlankContent(doc));
              setTab(sections.length);
            } else setTab(Number(event.target.value));
          }}
        >
          {sections.map((section, i) => (
            <option key={i} value={i}>
              {section.dataset.name ?? `Tab ${i + 1}`}
            </option>
          ))}
          {!readOnly && <option value="new">{t("Add tab")}</option>}
        </select>
        <select
          aria-label={t("Font")}
          value={body.getAttribute("data-font") ?? "serif"}
          disabled={readOnly}
          onChange={(event) => {
            body.setAttribute("data-font", event.target.value);
            body.setAttribute("style", `font-family:${event.target.value}`);
            onChange(serializeBlankContent(doc));
          }}
        >
          <option value="serif">{t("Serif")}</option>
          <option value="sans-serif">{t("Sans serif")}</option>
          <option value="monospace">{t("Monospace")}</option>
        </select>
        <Tool
          label={wide ? "Make page narrow" : "Make page wide"}
          onClick={() => setWide(!wide)}
        >
          <Maximize2 size={14} />
        </Tool>
        <span className="blank-tool-divider" />
        <Tool
          label="Table"
          disabled={readOnly}
          onClick={() => handle.current?.insert(table)}
        >
          <Table size={14} />
        </Tool>
        <Tool
          label="Image"
          disabled={readOnly}
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
          label="Checklist"
          disabled={readOnly}
          onClick={() =>
            handle.current?.insert(
              '<ul data-checklist=""><li>☐ </li></ul><p><br></p>',
            )
          }
        >
          <CheckSquare size={14} />
        </Tool>
        <Tool
          label="Insert"
          disabled={readOnly}
          onClick={() => handle.current?.insert("<p><br></p>")}
        >
          <Plus size={14} />
        </Tool>
        <span className="blank-save-status">{status}</span>
      </div>
      <input
        ref={image}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
      />
      <div className="blank-document-scroll">
        <div
          className="blank-document-page"
          style={{ fontFamily: body.getAttribute("data-font") ?? "serif" }}
        >
          <Editable
            key={index}
            handle={handle}
            html={current.innerHTML}
            onChange={update}
            label="Document content"
            readOnly={readOnly}
            className="blank-document-body"
          />
          <div
            className="blank-document-placeholder"
            aria-hidden="true"
            hidden={Boolean(
              current.textContent?.trim() || current.querySelector("img,table"),
            )}
          >
            <span>{t("Title")}</span>
            <p>{t("Start typing, or ask @Claudex to write")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
