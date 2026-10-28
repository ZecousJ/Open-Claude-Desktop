// : zu, the 500ms decision-surface guard.
export function artifactToolReadiness(
  document: Document,
  update: (ready: boolean) => void,
  clock: {
    set: (callback: () => void, delay: number) => unknown;
    clear: (timer: unknown) => void;
  } = {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
) {
  let ready = false;
  const pointers = new Set<number>();
  const check = () => {
    if (pointers.size || document.activeElement?.tagName === "IFRAME") {
      timer = clock.set(check, 500);
      return;
    }
    ready = true;
    update(true);
  };
  let timer = clock.set(check, 500);
  const reset = () => {
    ready = false;
    update(false);
    clock.clear(timer);
    timer = clock.set(check, 500);
  };
  const event = (event: Event) => {
    const pointer = event as PointerEvent;
    if (event.type === "pointerdown") pointers.add(pointer.pointerId);
    else if (event.type === "pointerup" || event.type === "pointercancel") {
      if (!pointers.delete(pointer.pointerId)) {
        reset();
        return;
      }
    } else if (event.type === "pointermove" && pointer.buttons === 0) {
      pointers.delete(pointer.pointerId);
      return;
    }
    if (!ready) reset();
  };
  const controller = new AbortController();
  for (const name of [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "pointermove",
    "keydown",
    "wheel",
  ])
    document.addEventListener(name, event, {
      capture: true,
      passive: name === "wheel" || name === "pointermove",
      signal: controller.signal,
    });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) reset();
    },
    { signal: controller.signal },
  );
  return () => {
    clock.clear(timer);
    controller.abort();
    update(false);
  };
}
