import { bridgeMethods } from "./bridge-methods";

export type EditCommand = "undo" | "redo";

export interface EditCommandsAPI {
  claimEditCommands(): Promise<void>;
  releaseEditCommands(): Promise<void>;
  reportContextMenuEditor(ownHistory: boolean): Promise<void>;
  editCommandUnclaimed(command: EditCommand): Promise<void>;
}

export const editCommandsMethods = bridgeMethods<EditCommandsAPI>({
  claimEditCommands: true,
  releaseEditCommands: true,
  reportContextMenuEditor: true,
  editCommandUnclaimed: true,
});
