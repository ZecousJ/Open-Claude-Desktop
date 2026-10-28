import { Menu, type App, type ContextMenuParams } from "electron";
import { contextMenuOwnsHistory, routeEditCommand } from "./edit-commands";

/**
 * The menu right-clicking a text field opens: Cut, Copy and Paste, each greyed
 * when it cannot act (an empty field greys all three). Claimed editors prepend
 * their own Undo/Redo. Only in the app's own windows; pages that open their own
 * menu (rows, messages) stop the event before it gets here.
 */
export function editMenuTemplate(params: Pick<ContextMenuParams, "editFlags">) {
  return [
    { role: "cut" as const, enabled: params.editFlags.canCut },
    { role: "copy" as const, enabled: params.editFlags.canCopy },
    { role: "paste" as const, enabled: params.editFlags.canPaste },
  ];
}

/**
 * The menu right-clicking selected reply text opens: Look Up is macOS's own
 * dictionary lookup, so other systems get Copy alone.
 */
export function selectionMenuTemplate(
  selection: string,
  platform: string,
  lookUp: () => void,
) {
  const shown = selection.trim().replace(/\s+/g, " ");
  const label = shown.length > 20 ? `${shown.slice(0, 20)}…` : shown;
  return [
    ...(platform === "darwin"
      ? [{ label: `Look Up “${label}”`, click: lookUp }]
      : []),
    { role: "copy" as const },
  ];
}

export function installEditContextMenu(
  app: App,
  developer?: {
    allowed: () => boolean;
    inspectLabel: () => string;
    translate?: (value: string) => string;
  },
) {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window") return;
    contents.on("context-menu", (_menuEvent, params) => {
      const inspect = developer?.allowed()
        ? [
            {
              label: developer.inspectLabel(),
              click: () => {
                if (developer.allowed())
                  contents.inspectElement(params.x, params.y);
              },
            },
          ]
        : [];
      if (params.isEditable) {
        const ownHistory = contextMenuOwnsHistory(contents);
        Menu.buildFromTemplate([
          ...(ownHistory
            ? [
                {
                  label: developer?.translate?.("Undo") ?? "Undo",
                  click: () => routeEditCommand("undo", contents),
                },
                {
                  label: developer?.translate?.("Redo") ?? "Redo",
                  click: () => routeEditCommand("redo", contents),
                },
                { type: "separator" as const },
              ]
            : []),
          ...editMenuTemplate(params),
          ...inspect,
        ]).popup();
        return;
      }
      if (!params.selectionText.trim()) {
        if (inspect.length) Menu.buildFromTemplate(inspect).popup();
        return;
      }
      Menu.buildFromTemplate([
        ...selectionMenuTemplate(params.selectionText, process.platform, () =>
          contents.showDefinitionForSelection(),
        ),
        ...inspect,
      ]).popup();
    });
  });
}
