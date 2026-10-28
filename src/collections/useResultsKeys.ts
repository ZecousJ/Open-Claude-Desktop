import { useCallback, type KeyboardEvent, type RefObject } from "react";

/**
 * Keyboard travel between a collection page's search box and its result cards:
 * ArrowDown in the box moves to the first card, ArrowUp/ArrowDown move between
 * cards (the first card's ArrowUp and Escape in the results go back to the
 * box). A card is every element in the results marked `data-primary`.
 * `escapeInInput` is what Escape does in the box itself (the original just
 * leaves it).
 */
export function useResultsKeys(
  input: RefObject<HTMLInputElement | null>,
  results: RefObject<HTMLElement | null>,
  escapeInInput?: () => void,
) {
  const cards = useCallback(
    () =>
      Array.from(
        results.current?.querySelectorAll<HTMLElement>("[data-primary]") ?? [],
      ),
    [results],
  );
  const toInput = useCallback(() => {
    const box = input.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [input]);
  return {
    onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (escapeInInput) escapeInInput();
        else input.current?.blur();
        return;
      }
      if (event.key !== "ArrowDown") return;
      const first = cards()[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    },
    onResultsKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.nativeEvent.isComposing || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        toInput();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const list = cards();
      const active = document.activeElement;
      const at = list.findIndex((card) => card === active);
      if (at === -1) return;
      if (event.key === "ArrowUp" && at === 0) {
        event.preventDefault();
        toInput();
        return;
      }
      const next =
        list[
          Math.min(list.length - 1, at + (event.key === "ArrowDown" ? 1 : -1))
        ];
      if (!next || next === active) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    },
  };
}
