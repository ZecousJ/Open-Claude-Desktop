import { useEffect, useRef } from "react";
import {
  chooseLook,
  smooth,
  textureGrid,
  TextureHand,
  textureReceivesTap,
} from "./landing-texture-model";
import type { TextureRenderer } from "./landing-texture-renderer";
import "./code-landing-texture.css";

/** Code-only decorative layer. Behaviour reference: c9d397622-DX28hmOj:981–1331;
 * mount delay: c2770df39---30gZSy:224 (3000ms). */
export function mountCodeLandingTexture(
  host: HTMLDivElement,
  loadRenderer = () => import("./landing-texture-renderer"),
) {
  const parent = host.parentElement;
  if (!parent) return () => {};
  const doc = host.ownerDocument,
    win = doc.defaultView!;
  if (
    !win ||
    typeof win.matchMedia !== "function" ||
    typeof win.ResizeObserver !== "function" ||
    typeof win.MutationObserver !== "function"
  )
    return () => {};
  const motion = win.matchMedia("(prefers-reduced-motion: reduce)");
  const contrast = win.matchMedia(
    "(prefers-contrast: more), (forced-colors: active)",
  );
  let destroyed = false,
    renderer: TextureRenderer | null = null,
    loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined,
    frame = 0,
    launch: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  let active = 0,
    last = performance.now(),
    windTime = 0,
    revealFrom = 0,
    resumed = -3,
    budget = 180;
  let ready = false,
    calm = false,
    busy = false,
    late = 0,
    stalls = 0,
    retrySeconds = 60;
  let recentLate: boolean[] = [];
  const hand = new TextureHand();
  const reduced = () =>
    doc.documentElement.dataset.motion === "reduced" || motion.matches;
  const visible = () => !doc.hidden && doc.hasFocus();
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const state = () => {
    if (!renderer) return;
    const shown = reduced() || (!busy && visible());
    renderer.canvas.style.opacity = shown ? "0.78" : "0";
    host.dataset.textureState = reduced()
      ? "still"
      : busy
        ? "busy"
        : !visible()
          ? "unseen"
          : calm
            ? "calm"
            : "moving";
  };
  const draw = () => {
    if (!renderer || !ready) return;
    renderer.draw({
      time: windTime,
      reveal: reduced()
        ? 1
        : smooth((active - revealFrom) / 4) *
          (1 - smooth((active - budget) / 8)),
      touch: reduced()
        ? undefined
        : hand.frame((performance.now() - started) / 1000),
    });
  };
  const canRun = () =>
    !destroyed &&
    !!renderer &&
    ready &&
    !reduced() &&
    !contrast.matches &&
    visible() &&
    !busy &&
    !calm;
  const suspend = () => {
    busy = true;
    stop();
    state();
    clearTimeout(retry);
    retry = setTimeout(() => {
      busy = false;
      late = 0;
      recentLate = [];
      resumed = active;
      revealFrom = active;
      state();
      schedule();
    }, retrySeconds * 1000);
    retrySeconds = Math.min(480, retrySeconds * 2);
  };
  const tick = (scheduled: number) => {
    frame = 0;
    if (!canRun()) return;
    const before = performance.now();
    recentLate = [...recentLate.slice(-9), before - scheduled > 17];
    if (recentLate.filter(Boolean).length >= 5) {
      recentLate = [];
      if (++late >= 2) {
        suspend();
        return;
      }
    }
    const delta = Math.min(0.25, Math.max(0, (before - last) / 1000));
    last = before;
    active += delta;
    const fade = 1 - smooth((active - budget) / 8);
    windTime += delta * fade * smooth((active - resumed) / 3);
    draw();
    const now = (performance.now() - started) / 1000;
    if (fade === 0 && !hand.busy(now)) {
      calm = true;
      retrySeconds = 60;
      state();
      return;
    }
    stalls = performance.now() - before > 50 ? stalls + 1 : 0;
    if (stalls >= 3) {
      suspend();
      return;
    }
    if (renderer?.fellBehind() && ++late >= 2) {
      suspend();
      return;
    }
    schedule();
  };
  const schedule = () => {
    if (timer !== undefined || frame || !canRun()) return;
    const now = (performance.now() - started) / 1000;
    timer = setTimeout(
      () => {
        timer = undefined;
        const scheduled = performance.now();
        frame = requestAnimationFrame(() => tick(scheduled));
      },
      late ? 83 : hand.rippling(now) ? 10 : 40,
    );
  };
  const activity = () => {
    if (reduced() || !ready || busy) return;
    if (calm) {
      calm = false;
      budget = active + 180;
      resumed = active;
      revealFrom = active;
      last = performance.now();
      state();
    } else if (active < budget) budget = active + 180;
    schedule();
  };
  const point = (event: PointerEvent): [number, number] => {
    const box = host.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || reduced() || busy || !ready) return;
    hand.move(...point(event), (performance.now() - started) / 1000);
    activity();
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || reduced() || busy || !ready) return;
    if (
      textureReceivesTap(
        event.target instanceof Element ? event.target : null,
        parent,
        event.button,
      )
    )
      hand.tap(...point(event), (performance.now() - started) / 1000);
    activity();
  };
  const onLeave = () => hand.leave();
  const onKey = () => activity();
  const ink = () => {
    if (!renderer) return;
    const style = getComputedStyle(host),
      light = doc.documentElement.dataset.theme === "light";
    const swatch = doc.createElement("canvas");
    swatch.width = swatch.height = 1;
    const ctx = swatch.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.fillStyle = style.color;
      ctx.fillRect(0, 0, 1, 1);
      const c = ctx.getImageData(0, 0, 1, 1).data;
      renderer.setInk([c[0] / 255, c[1] / 255, c[2] / 255], c[3] / 255);
    }
    renderer.setGlow(light ? [0, 0.25, 1] : [0.1, 0.68, 1]);
    state();
  };
  const resize = () => {
    if (!renderer) return;
    const rect = host.getBoundingClientRect(),
      scale = win.devicePixelRatio || 1;
    const grid = textureGrid(
      Math.round(rect.width * scale),
      Math.round(rect.height * scale),
      scale,
    );
    ready = !!grid && renderer.resize(grid, [rect.width, rect.height]);
    renderer.canvas.style.visibility =
      ready && !contrast.matches ? "" : "hidden";
    ink();
    draw();
    stop();
    last = performance.now();
    schedule();
  };
  let started = performance.now();
  const begin = async () => {
    launch = undefined;
    if (destroyed || loading || renderer || contrast.matches || !visible())
      return;
    loading = true;
    host.dataset.textureState = "loading";
    try {
      await doc.fonts
        ?.load(`400 16px ${getComputedStyle(host).fontFamily}`, ".")
        .catch(() => undefined);
      if (destroyed) return;
      const { createTextureRenderer } = await loadRenderer();
      if (destroyed) return;
      const seed = win.crypto.getRandomValues(new Uint32Array(1))[0];
      let previous: string[] = [];
      try {
        const value = JSON.parse(
          win.localStorage.getItem("claudex-code-texture-looks") ?? "[]",
        );
        if (Array.isArray(value))
          previous = value.filter((x) => typeof x === "string");
      } catch {}
      const look = chooseLook(seed, previous);
      const next = await createTextureRenderer(
        host,
        seed,
        look,
        () => destroyed,
      );
      if (destroyed) {
        next?.destroy();
        return;
      }
      renderer = next;
      if (!renderer) {
        host.dataset.textureState = "unsupported";
        return;
      }
      try {
        win.localStorage.setItem(
          "claudex-code-texture-looks",
          JSON.stringify(
            [look, ...previous.filter((k) => k !== look)].slice(0, 3),
          ),
        );
      } catch {}
      renderer.canvas.dataset.look = `${look}/${seed.toString(16)}`;
      renderer.canvas.addEventListener("webglcontextlost", lost);
      started = performance.now();
      last = started;
      windTime = (seed / 4294967296) * 64;
      resize();
    } catch {
      if (!destroyed) {
        ready = false;
        renderer?.destroy();
        renderer = null;
        host.dataset.textureState = "unsupported";
      }
    } finally {
      loading = false;
    }
  };
  const lost = () => {
    ready = false;
    stop();
    if (renderer) renderer.canvas.style.visibility = "hidden";
    host.dataset.textureState = "context-lost";
  };
  const refresh = () => {
    if (destroyed) return;
    if (!renderer) {
      if (!doc.hidden && launch === undefined)
        launch = setTimeout(() => void begin(), 3000);
      return;
    }
    stop();
    last = performance.now();
    if (calm && visible() && !reduced()) activity();
    if (reduced()) {
      ink();
      draw();
      state();
      return;
    }
    state();
    schedule();
  };
  const observer = new win.ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });
  observer.observe(host);
  const attributes = new win.MutationObserver(() => {
    stop();
    ink();
    draw();
    refresh();
  });
  attributes.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-motion", "style"],
  });
  const accessibility = () => {
    if (contrast.matches) {
      stop();
      if (renderer) renderer.canvas.style.visibility = "hidden";
    } else if (renderer) resize();
    else refresh();
  };
  parent.addEventListener("pointermove", onMove, { passive: true });
  parent.addEventListener("pointerdown", onDown, { passive: true });
  parent.addEventListener("pointerleave", onLeave, { passive: true });
  parent.addEventListener("keydown", onKey, { capture: true, passive: true });
  doc.addEventListener("visibilitychange", refresh);
  win.addEventListener("focus", refresh);
  win.addEventListener("blur", refresh);
  motion.addEventListener("change", refresh);
  contrast.addEventListener("change", accessibility);
  refresh();
  return () => {
    destroyed = true;
    stop();
    clearTimeout(launch);
    clearTimeout(resizeTimer);
    clearTimeout(retry);
    observer.disconnect();
    attributes.disconnect();
    parent.removeEventListener("pointermove", onMove);
    parent.removeEventListener("pointerdown", onDown);
    parent.removeEventListener("pointerleave", onLeave);
    parent.removeEventListener("keydown", onKey, { capture: true });
    doc.removeEventListener("visibilitychange", refresh);
    win.removeEventListener("focus", refresh);
    win.removeEventListener("blur", refresh);
    motion.removeEventListener("change", refresh);
    contrast.removeEventListener("change", accessibility);
    renderer?.canvas.removeEventListener("webglcontextlost", lost);
    renderer?.destroy();
  };
}

export function CodeLandingTexture() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) return mountCodeLandingTexture(ref.current);
  }, []);
  return (
    <div
      ref={ref}
      className="code-landing-texture mono"
      aria-hidden="true"
      data-texture-state="waiting"
    />
  );
}
