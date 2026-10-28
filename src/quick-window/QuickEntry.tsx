import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  quickEntryMaxLength,
  quickEntryPlaceholder,
  type QuickEntryBridge,
  type QuickEntryImage,
} from "../../shared/quick-entry";
import { Star } from "../ui/Star";
import { t } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { joinSpoken } from "../../shared/voice-api";

const QuickEntryDictation = lazyPiece(
  () => import("./QuickEntryDictation"),
  "QuickEntryDictation",
);

/**
 * The Quick Entry composer (shared/quick-entry.ts): the Claudex mark and
 * one field. Enter sends what is typed (Shift+Enter or Option+Enter starts
 * a new line), Escape puts it away. The window takes the composer's height
 * as the field grows; the mark and the padding drag the window.
 */
export function QuickEntry({ bridge }: { bridge: QuickEntryBridge }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [images, setImages] = useState<QuickEntryImage[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const dictatingRef = useRef(false);
  const beforeDictation = useRef("");
  const currentText = useRef(text);
  currentText.current = text;
  const endDictation = () => {
    dictatingRef.current = false;
    setDictating(false);
    setStopping(false);
  };
  const addImages = async (files: File[]) => {
    try {
      const pictures = files.filter((file) =>
        /^image\/(png|jpeg|gif|webp)$/.test(file.type),
      );
      if (
        pictures.length + images.length > 10 ||
        pictures.reduce(
          (bytes, file) => bytes + file.size,
          images.reduce((bytes, image) => bytes + image.data.byteLength, 0),
        ) >
          30 * 1024 * 1024
      )
        throw Error("This file can't be attached.");
      const next = await Promise.all(
        pictures.map(async (file) => ({
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        })),
      );
      setImages((current) => [...current, ...next].slice(0, 10));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(
    () =>
      bridge.onShown((height) => {
        document.documentElement.style.setProperty(
          "--quick-viewport-height",
          `${height ?? screen.availHeight}px`,
        );
        // The draft stays through Escape and a click away; only sending
        // clears it (desktop client 2.37337.1, quick_window main: Enter
        // empties the field, dismissing does not).
        setError("");
        field.current?.focus();
      }),
    [],
  );
  useEffect(
    () =>
      bridge.onDictation?.((action) => {
        if (
          action === "stop" ||
          (action === "toggle" && dictatingRef.current)
        ) {
          if (dictatingRef.current) setStopping(true);
        } else if (!dictatingRef.current && bridge.voice) {
          beforeDictation.current = currentText.current;
          dictatingRef.current = true;
          setStopping(false);
          setDictating(true);
        }
      }),
    [],
  );
  useEffect(() => bridge.onHidden?.(endDictation), []);
  useEffect(() => {
    bridge.ready?.();
  }, []);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const report = () => bridge.resize(element.offsetHeight);
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="quick-entry">
      <div className="quick-entry-mark" aria-hidden="true">
        <Star size={18} />
      </div>
      <div className="quick-entry-field">
        <div className="quick-entry-input">
          <textarea
            ref={field}
            autoFocus
            rows={1}
            maxLength={quickEntryMaxLength}
            aria-label={t(quickEntryPlaceholder)}
            placeholder={t(quickEntryPlaceholder)}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                if (dictatingRef.current) {
                  setStopping(true);
                  return;
                }
                setBusy(true);
                void Promise.resolve()
                  .then(() => bridge.submit(text, images))
                  .then(() => {
                    setText("");
                    setImages([]);
                    setError("");
                  })
                  .catch((error: unknown) =>
                    setError(
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
                  .finally(() => setBusy(false));
              }
            }}
            onKeyUp={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                bridge.dismiss();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (!files.length) return;
              event.preventDefault();
              void addImages(files);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              void addImages(Array.from(event.dataTransfer.files));
            }}
          />
        </div>
        {dictating && bridge.voice && (
          <Suspense fallback={null}>
            <QuickEntryDictation
              voice={bridge.voice}
              stopping={stopping}
              onLive={(spoken) =>
                setText(joinSpoken(beforeDictation.current, spoken))
              }
              onDone={(spoken) => {
                setText(joinSpoken(beforeDictation.current, spoken));
                endDictation();
                field.current?.focus();
              }}
              onCancel={() => {
                setText(beforeDictation.current);
                endDictation();
              }}
              onError={(error) => {
                setError(
                  error instanceof Error ? error.message : String(error),
                );
                endDictation();
              }}
            />
          </Suspense>
        )}
        {images.length > 0 && (
          <div>
            {images.map((image, index) => (
              <button
                type="button"
                key={index}
                aria-label={t("Remove attachment")}
                onClick={() =>
                  setImages((current) =>
                    current.filter((_, at) => at !== index),
                  )
                }
              >
                {image.name} ×
              </button>
            ))}
          </div>
        )}
        {error && <div role="alert">{t(error)}</div>}
      </div>
    </div>
  );
}
