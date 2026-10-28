import { useLayoutEffect, useRef } from "react";

type Lease = { previous: string };
const owners = new WeakMap<HTMLElement, Lease>();
const property = "--chat-composer-measure";

/** The shared Chat column follows its committed dock, not a scrollport's
 * platform-dependent scrollbar gutter (1016 shared-6 jw). The real Composer
 * owns this ref, so a lazy parent cannot attempt attachment before commit.
 * Layout measurement avoids adding a container around fixed-position menus. */
export function useChatTranscriptColumn(enabled: boolean, scope?: object) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    const dock = ref.current;
    const main = dock?.closest<HTMLElement>(".chat-main.has-conversation");
    if (!dock || !main?.closest(".app.mode-chat")) return;
    const previous =
      owners.get(main)?.previous ?? main.style.getPropertyValue(property);
    const lease: Lease = { previous };
    owners.set(main, lease);
    const view = main.ownerDocument.defaultView;
    const update = () => {
      if (owners.get(main) !== lease || !dock.isConnected) return;
      if ((view?.innerWidth ?? 0) < 768) {
        main.style.removeProperty(property);
        return;
      }
      const width = dock.getBoundingClientRect().width;
      if (width > 0 && Number.isFinite(width)) {
        const value = `${width}px`;
        if (main.style.getPropertyValue(property) !== value)
          main.style.setProperty(property, value);
      }
    };
    update();
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(update)
        : undefined;
    observer?.observe(dock);
    view?.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      view?.removeEventListener("resize", update);
      if (owners.get(main) !== lease) return;
      owners.delete(main);
      if (previous) main.style.setProperty(property, previous);
      else main.style.removeProperty(property);
    };
  }, [enabled, scope]);
  return ref;
}
