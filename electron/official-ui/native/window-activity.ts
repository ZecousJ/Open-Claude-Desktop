import type { NativeHost } from "./host";

/** Native focus is per window; broadcasting one window's blur greys every window. */
export function observeWindowActivity(
  window: {
    isDestroyed(): boolean;
    isFocused(): boolean;
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
  },
  changed: (active: boolean) => void,
) {
  const focus = () => {
    if (!window.isDestroyed()) changed(true);
  };
  const blur = () => {
    if (!window.isDestroyed()) changed(false);
  };
  window.on("focus", focus);
  window.on("blur", blur);
  return () => {
    window.removeListener("focus", focus);
    window.removeListener("blur", blur);
  };
}

export function observeWindowPresentation(
  window: {
    isDestroyed(): boolean;
    isVisible(): boolean;
    on(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
  },
  changed: (
    event: "visibilityChanged" | "fullscreenChanged",
    value: boolean,
  ) => void,
) {
  const visibility = () => {
    if (!window.isDestroyed()) changed("visibilityChanged", window.isVisible());
  };
  const fullScreen = (value: boolean) => () => {
    if (!window.isDestroyed()) changed("fullscreenChanged", value);
  };
  const listeners = {
    show: visibility,
    hide: visibility,
    "enter-full-screen": fullScreen(true),
    "leave-full-screen": fullScreen(false),
  };
  for (const [event, listener] of Object.entries(listeners))
    window.on(event, listener);
  return () => {
    for (const [event, listener] of Object.entries(listeners))
      window.removeListener(event, listener);
  };
}

export function registerWindowActivity(host: NativeHost) {
  host.on("WindowState.getWindowActive", () => {
    const window = host.caller ?? host.window;
    return !!window && !window.isDestroyed() && window.isFocused();
  });
  host.on("WindowState.getAppFocused", () => host.isAnyWindowFocused());
  host.on("WindowState.getVisibility", () => {
    const window = host.caller ?? host.window;
    return !!window && !window.isDestroyed() && window.isVisible();
  });
  host.on("WindowState.getOnScreen", () => {
    const window = host.caller ?? host.window;
    return (
      !!window &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized()
    );
  });
}
