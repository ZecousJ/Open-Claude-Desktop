/** Official 4.4212.0: gTi/ZTi/eEi/fEi/gEi/yEi/RTi in index.chunk-m4oMImJ-.js. */
export interface PreviewInput {
  type: string;
  key: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  isAutoRepeat?: boolean;
}
export type PreviewAction =
  | "close"
  | "new"
  | "reopen"
  | "address"
  | "reload"
  | "back"
  | "forward"
  | "next"
  | "previous"
  | "exit"
  | "pane"
  | "select"
  | "sketch"
  | number;
export function previewAction(
  input: PreviewInput,
  mac: boolean,
  page: boolean,
  chromeFocused: boolean,
  armed: boolean,
): PreviewAction | undefined {
  if (input.type !== "keyDown" || input.alt) return;
  const key = input.key.toLowerCase(),
    cmd = mac ? input.meta : input.control,
    other = mac ? input.control : input.meta;
  if (page && key === "f6" && !input.meta) return "exit";
  if (cmd && !other) {
    if (!input.shift) {
      if (key === "t") return "new";
      if ((page || chromeFocused) && key === "w") return "close";
      if (page || chromeFocused) {
        const action = (
          { l: "address", r: "reload", "[": "back", "]": "forward" } as const
        )[key as "l"];
        if (action) return action;
      }
      if (page && /^Digit[1-9]$/.test(input.code ?? ""))
        return input.code === "Digit9" ? -1 : Number(input.code!.slice(5)) - 1;
    } else if (page || chromeFocused) {
      if (key === "t") return "reopen";
      if (page && armed && (key === "p" || key === "b")) return "pane";
      if (page && key === "s") return "select";
      if (page && key === "x") return "sketch";
    }
  }
  if ((page || chromeFocused) && input.control && !input.meta && key === "tab")
    return input.shift ? "previous" : "next";
}
