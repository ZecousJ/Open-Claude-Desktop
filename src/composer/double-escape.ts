// Empty-editor recall.
export function doubleEscape() {
  let armed: number | undefined;
  return (
    event: {
      key: string;
      repeat: boolean;
      isComposing: boolean;
      defaultPrevented: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    },
    enabled: boolean,
    now = Date.now(),
  ) => {
    const previous = armed;
    armed = undefined;
    if (
      !enabled ||
      event.key !== "Escape" ||
      event.repeat ||
      event.isComposing ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    )
      return false;
    if (previous !== undefined && now - previous <= 800) return true;
    armed = now;
    return false;
  };
}

export const editLastMessageEvent = "claudex:edit-last-message";
