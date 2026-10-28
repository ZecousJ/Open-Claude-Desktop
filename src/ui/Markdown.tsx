import { presentationId } from "./presentation-id";
import { connectorLinkId, openSettingsLink } from "../settings/navigation";
import { CodeRunButton, CodeRunOutput } from "../code-run/CodeRunControls";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Suspense } from "react";
import type { Components } from "react-markdown";
import { MarkdownRenderer as ReactMarkdown } from "./MarkdownRenderer";
import { useRehypeHighlight } from "./lazy-highlight";
import { ExternalLink, Info } from "./glyphs";
import { t, tf } from "../i18n";
import { exceedsCodeSizeLimit, rehypeCodeSizeLimit } from "./markdown-code";
import "./markdown-parity.css";
import { ArtifactCard } from "../artifacts/LazyArtifactCard";
import { useCapabilities } from "../artifacts/capabilities";
import { useLocalFileLinks } from "../transcript/local-file-links";
import { lazyPiece, preloadPiece } from "./lazy-piece";
// A visualization's frame and its document builders load with the first one.
const InlineVisualization = lazyPiece(
  () => import("./InlineVisualization"),
  "InlineVisualization",
);
const InlineMermaid = lazyPiece(
  () => import("./InlineMermaid"),
  "InlineMermaid",
);
export const preloadInlineMermaid = () => preloadPiece(InlineMermaid);
/** For server rendering (tests): have the visualization frame ready. */
export const preloadInlineVisualization = () =>
  preloadPiece(InlineVisualization);
import { CopyButton } from "./Controls";
import type { Artifact } from "./ArtifactTypes";
import { MarkdownImage } from "./MarkdownImage";
import { MarkdownTable } from "./MarkdownTable";
import { normalizeMathDelimiters } from "./markdown-math";
import {
  StreamReveal,
  rehypeStreamReveal,
  type RevealMode,
} from "./stream-reveal";
import { externalUrl, useOpenLink } from "./ExternalLinks";
import { CitationChip } from "../citations/CitationChip";
import type { CitationGroup } from "../citations/citations";
import { citationTag, remarkCitations } from "../citations/remark-citations";
// Highlighted code contains nested spans. Preserve its original text when copying.
export function renderedText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return renderedText(node.props.children);
  return "";
}
type RemarkPlugins = NonNullable<
  Parameters<typeof ReactMarkdown>[0]["remarkPlugins"]
>;
type RehypePlugins = NonNullable<
  Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]
>;

// KaTeX (about 95 kB gzip with its styles) loads the first time a reply
// holds math, not with the page. maxSize (em) keeps a \rule or \kern in a
// reply from laying out a page-sized box.
// remark-math (which reads the $$…$$) comes with it.
let katex: RehypePlugins[number] | undefined;
let mathSyntax: RemarkPlugins[number] | undefined;
let katexLoading: Promise<void> | undefined;
export function loadKatex() {
  katexLoading ??= Promise.all([
    import("rehype-katex"),
    import("remark-math"),
    typeof document === "undefined"
      ? undefined
      : import("katex/dist/katex.min.css"),
  ]).then(([module, syntax]) => {
    katex = [
      module.default,
      { throwOnError: false, strict: "ignore", maxSize: 100 },
    ];
    mathSyntax = [syntax.default, { singleDollarTextMath: false }];
  });
  return katexLoading;
}
/** KaTeX once `source` has math (remark-math reads only $$…$$ here). */
function useKatex(source: string) {
  const needed = source.includes("$$");
  const [, setLoaded] = useState(false);
  useEffect(() => {
    if (needed && !katex) void loadKatex().then(() => setLoaded(true));
  }, [needed]);
  return needed ? katex : undefined;
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

/** The reply ends inside a code block whose closing fence has not arrived. */
export function endsInOpenFence(text: string) {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    if (!open) open = fence[1];
    else if (
      fence[1][0] === open[0] &&
      fence[1].length >= open.length &&
      !fence[2].trim()
    )
      open = undefined;
  }
  return Boolean(open);
}

/**
 * While a reply streams, the code block still being written highlights only
 * its finished lines; the line being typed is kept aside
 * (`data-stream-tail`) and shown as plain text after them. Highlighting a
 * half-written line (an open string or comment) would recolour the whole
 * block on every delta.
 */
export function rehypeStreamingTail(options: { end: number }) {
  return (tree: HastNode) => {
    let last: HastNode | undefined;
    const walk = (node: HastNode) => {
      if (node.type === "element" && node.tagName === "pre") last = node;
      node.children?.forEach(walk);
    };
    walk(tree);
    if (!last || last.position?.end?.offset !== options.end) return;
    const code = last.children?.find(
      (child) => child.type === "element" && child.tagName === "code",
    );
    const text = code?.children?.length === 1 ? code.children[0] : undefined;
    if (!code || text?.type !== "text" || typeof text.value !== "string")
      return;
    const body = text.value.replace(/\n$/, "");
    const cut = body.lastIndexOf("\n");
    const tail = body.slice(cut + 1);
    if (!tail) return;
    text.value = body.slice(0, cut + 1);
    code.properties = { ...code.properties, dataStreamTail: tail };
  };
}

/**
 * The reveal scheduler while a reply streams, and for a moment after it
 * ends so the last words finish fading (then the reply renders plain).
 */
function useStreamReveal(
  source: string,
  streaming: boolean,
  mode: RevealMode,
): StreamReveal | null {
  const scheduler = useRef<StreamReveal | null>(null);
  const [settled, setSettled] = useState(!streaming);
  if (streaming) {
    if (!scheduler.current || scheduler.current.mode !== mode)
      scheduler.current = new StreamReveal(mode);
    if (settled) setSettled(false);
  }
  useEffect(() => {
    if (streaming || settled || !scheduler.current) return;
    const timer = window.setTimeout(
      () => setSettled(true),
      scheduler.current.settleMs,
    );
    return () => window.clearTimeout(timer);
  }, [streaming, settled]);
  if (settled && !streaming) scheduler.current = null;
  scheduler.current?.sync(source);
  return scheduler.current;
}

/**
 * Renders a reply's Markdown. The block renderers keep their identity while
 * the text streams in, so every top-level block (keyed `p-0`, `pre-1`, … by
 * position and tag) keeps its DOM node and state across updates: only a
 * block that is new is inserted, which a stylesheet can fade in (G-29).
 */
export function Markdown({
  text,
  onArtifact,
  streaming = false,
  revealMode = "word",
  citations,
  extraRehypePlugins,
  extraComponents,
}: {
  text: string;
  /** Omitted where nothing can open (a Markdown artifact's own preview): no card or Open button. */
  onArtifact?: (artifact: Artifact) => void;
  /** The reply is still arriving: an unfinished code block grows line by line. */
  streaming?: boolean;
  /** How streamed words appear (src/ui/stream-reveal.ts). */
  revealMode?: RevealMode;
  /**
   * The reply's citation groups (R5): `text` then carries markers from
   * `citationRender` (src/citations/citations.ts), each shown as a chip.
   * Without it the text renders exactly as before.
   */
  citations?: CitationGroup[];
  extraRehypePlugins?: RehypePlugins;
  extraComponents?: Components;
}) {
  const source = normalizeMathDelimiters(text);
  // Only while the last line of an open code block is still being typed.
  const tailAt =
    streaming && !source.endsWith("\n") && endsInOpenFence(source)
      ? source.length
      : undefined;
  const math = useKatex(source);
  // Code fences (``` or ~~~) and indented code both start a line.
  const highlight = useRehypeHighlight(/(^|\n)(```|~~~|    \S)/.test(source));
  const reveal = useStreamReveal(source, streaming, revealMode);
  const plugins = useMemo<RehypePlugins>(
    () => [
      ...(math ? [math] : []),
      rehypeCodeSizeLimit,
      ...(tailAt === undefined
        ? []
        : [[rehypeStreamingTail, { end: tailAt }] as RehypePlugins[number]]),
      ...(reveal
        ? [[rehypeStreamReveal, { reveal }] as RehypePlugins[number]]
        : []),
      ...(highlight ? [highlight] : []),
      ...(extraRehypePlugins ?? []),
    ],
    // react-markdown runs the plugins on every render, so the scheduler is
    // read afresh each time the text grows.
    [tailAt, math, reveal, highlight, extraRehypePlugins],
  );
  const citationCount = citations?.length ?? 0;
  const remark = useMemo<RemarkPlugins>(
    () => [
      ...(math && mathSyntax ? [mathSyntax] : []),
      ...(citationCount
        ? [[remarkCitations, { count: citationCount }] as RemarkPlugins[number]]
        : []),
    ],
    [citationCount, math],
  );
  const openLink = useOpenLink();
  // The latest callbacks and citations, read when a chip renders or a link
  // or Open is clicked.
  // The text of a reply whose last code block is still open.
  const openSource =
    streaming && endsInOpenFence(source) ? source.trimEnd() : undefined;
  const resolveFile = useLocalFileLinks();
  const latest = useRef({
    openLink,
    onArtifact,
    citations,
    openSource,
    resolveFile,
  });
  latest.current = { openLink, onArtifact, citations, openSource, resolveFile };
  const canOpen = Boolean(onArtifact);
  const { inlineVisualizations, artifacts } = useCapabilities();
  const components = useMemo<Components>(() => {
    const open = (artifact: Artifact) => latest.current.onArtifact?.(artifact);
    return {
      table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
      a: ({ href, children }) => {
        const connector = connectorLinkId(href);
        if (connector)
          return (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                openSettingsLink("connectors", connector);
              }}
            >
              {children}
            </a>
          );
        // A path on the agent's computer opens the file the conversation
        // wrote there; any other local path is plain text.
        const local = externalUrl(href)
          ? undefined
          : latest.current.resolveFile(href ?? "");
        if (!externalUrl(href) && !local) return <span>{children}</span>;
        return (
          <a
            href={local ? "#" : href}
            onClick={(e) => {
              e.preventDefault();
              const url = externalUrl(href);
              if (url) latest.current.openLink(url);
              else if (local) latest.current.onArtifact?.(local);
            }}
          >
            {children}
          </a>
        );
      },
      img: MarkdownImage,
      ...({
        [citationTag]: (props: Record<string, unknown>) => {
          const group =
            latest.current.citations?.[Number(props["data-citation"])];
          return group ? <CitationChip group={group} /> : null;
        },
      } as Components),
      pre: ({ children }) => {
        let child = children as any;
        // The streaming line kept out of highlighting follows the finished ones.
        const tail = child?.props?.["data-stream-tail"];
        if (typeof tail === "string" && isValidElement(child))
          child = cloneElement(
            child as ReactElement<Record<string, unknown>>,
            { "data-stream-tail": undefined },
            (child as any).props.children,
            <span key="stream-tail" className="code-stream-tail">
              {tail}
            </span>,
          );
        const rawCode = renderedText(child?.props?.children);
        const code = rawCode.replace(/\n$/, "");
        const declaredLanguage = /language-(\w+)/.exec(
          child?.props?.className ?? "",
        )?.[1];
        const language = declaredLanguage?.toLowerCase() ?? "text";
        if (language === "mermaid") {
          const open = latest.current.openSource;
          const writing = Boolean(open && open.endsWith(code.trimEnd()));
          if (writing || code.trimEnd().length > 20_000)
            return (
              <pre data-mermaid className="markdown-mermaid-source" dir="ltr">
                {code.trimEnd()}
              </pre>
            );
          return (
            <Suspense
              fallback={
                <div
                  className="markdown-mermaid is-loading"
                  dir="ltr"
                  data-mermaid
                  role="img"
                  aria-label={t("Mermaid diagram")}
                />
              }
            >
              <InlineMermaid code={code.trimEnd()} streaming={writing} />
            </Suspense>
          );
        }
        // Settings → Capabilities → Inline visualizations.
        if (inlineVisualizations && language === "visualization") {
          const open = latest.current.openSource;
          return (
            <Suspense fallback={null}>
              <InlineVisualization
                code={code}
                complete={!open || !open.endsWith(code.trimEnd())}
              />
            </Suspense>
          );
        }
        if (
          canOpen &&
          artifacts !== false &&
          language === "html" &&
          /<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(code)
        ) {
          const title =
            /<title[^>]*>([^<]+)<\/title>/i.exec(code)?.[1]?.trim() ||
            "HTML document";
          // Still arriving: the card says so and opens the generating view
          // instead of a half-written page.
          const openSource = latest.current.openSource;
          const writing = Boolean(
            openSource && openSource.endsWith(code.trimEnd()),
          );
          return (
            <ArtifactCard
              artifact={{
                id: writing
                  ? `html-writing:${title}`
                  : `html:${title}:${rawCode}`,
                name: title,
                language,
                content: rawCode,
                ...(writing ? { generating: true } : {}),
              }}
              onArtifact={open}
            />
          );
        }
        return (
          <>
            <div
              className={`code-block prose-block ${declaredLanguage ? "" : "plain-code"}`}
              data-plan-comment-skip
              role="group"
              aria-label={
                declaredLanguage
                  ? tf("{language} code", { language })
                  : t("Code")
              }
              tabIndex={0}
              dir="ltr"
            >
              <div className="code-bar">
                <div>
                  <div className="code-actions">
                    <CodeRunButton language={language} code={code} />
                    <CopyButton text={code.trimEnd()} iconOnly codeBlock />
                    {canOpen && (
                      <button
                        className="small-action code-open"
                        onClick={() =>
                          open({
                            id: presentationId(),
                            name: "Code",
                            language,
                            content: code,
                          })
                        }
                      >
                        <ExternalLink size={13} />
                        {t("Open")}
                      </button>
                    )}
                  </div>
                </div>
                {declaredLanguage && <span>{declaredLanguage}</span>}
              </div>
              {exceedsCodeSizeLimit(code) && (
                <div className="code-size-notice">
                  <Info size={20} aria-hidden="true" />
                  <span>
                    {t(
                      "Syntax highlighting has been disabled due to code size.",
                    )}
                  </span>
                </div>
              )}
              <pre>{child}</pre>
            </div>
            <CodeRunOutput code={code} />
          </>
        );
      },
    };
  }, [canOpen, inlineVisualizations, artifacts]);
  return (
    <ReactMarkdown
      preset="reply"
      remarkPlugins={remark}
      rehypePlugins={plugins}
      components={
        extraComponents ? { ...components, ...extraComponents } : components
      }
    >
      {source}
    </ReactMarkdown>
  );
}
