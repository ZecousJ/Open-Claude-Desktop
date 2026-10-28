import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Submenu } from "../ui/Submenu";
import { ComposerSheetBack, useComposerMenuPresentation } from "./menu-sheet";
import { useLocale, useT } from "../i18n";
import { dictationLanguages } from "./dictation-languages";
import { setDictationLanguage } from "../voice/dictation-language";
import { dictationLanguagePosition } from "./dictation-language-position";

export function DictationLanguageMenu({
  anchor,
  frame,
  value,
  onBack,
  onDone,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  frame: RefObject<HTMLDivElement | null>;
  value: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const sheet = useComposerMenuPresentation();
  const locale = useLocale();
  // shared-frame-B1JORnF0 xC/YS: stableWhileOpen retains the largest
  // measured height and bottom-aligns content after an end-side flip.
  const heldHeight = useRef(0);
  const endAligned = useRef<boolean>(undefined);
  const [place, setPlace] = useState({ left: -10000, top: 5, height: 0 });
  useLayoutEffect(() => {
    const popup = frame.current;
    if (!popup) return;
    const update = () => {
      const trigger = anchor.current?.getBoundingClientRect();
      if (!trigger) return;
      const rect = popup.getBoundingClientRect();
      const width = popup.offsetWidth || rect.width;
      const positioned = dictationLanguagePosition({
        trigger,
        width,
        contentHeight: popup.offsetHeight || rect.height,
        viewport: { width: innerWidth, height: innerHeight },
        previous: {
          heldHeight: heldHeight.current,
          alignEnd: endAligned.current,
        },
      });
      heldHeight.current = positioned.heldHeight;
      endAligned.current = positioned.alignEnd;
      const next = {
        left: positioned.left,
        top: positioned.top,
        height: positioned.height,
      };
      setPlace((previous) =>
        previous.left === next.left &&
        previous.top === next.top &&
        previous.height === next.height
          ? previous
          : next,
      );
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(popup);
    if (anchor.current) observer?.observe(anchor.current);
    addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      removeEventListener("resize", update);
    };
  }, [anchor, frame]);
  const entries = [
    { value: "", label: t("Auto") },
    ...dictationLanguages(locale),
  ].map((item) => ({
    label: item.label,
    checked: value === item.value,
    checkedRole: "radio" as const,
    onSelect: () => setDictationLanguage(item.value),
  }));
  return (
    <div
      className="dictation-language-positioner"
      style={{
        ...place,
        justifyContent: endAligned.current ? "flex-end" : "flex-start",
      }}
    >
      <Submenu
        ref={frame}
        label={t("Language")}
        className="dictation-language-menu"
        entries={entries}
        header={
          <ComposerSheetBack
            sheet={sheet}
            title={t("Language")}
            onBack={onBack}
          />
        }
        size="regular"
        searchable={t("Search languages")}
        searchEmpty={t("No matches")}
        left={0}
        top={0}
        focusOnOpen
        onArrive={() => {}}
        onBack={onBack}
        onDone={onDone}
      />
    </div>
  );
}
