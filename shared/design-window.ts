import type {
  BlankArtifact,
  BlankArtifactDocument,
  SaveBlankArtifactInput,
  SaveBlankArtifactResult,
} from "./blank-artifacts";
import type { Conversation, Turn } from "./types";

export type DesignWindowConversation = Pick<
  Conversation,
  "id" | "updatedAt"
> & {
  blankArtifact: BlankArtifact;
  lastTurn?: Pick<Turn, "id" | "status">;
};

export interface DesignWindowContext {
  readonly accountId: string;
  readonly conversation: DesignWindowConversation;
  readonly title: string;
  readonly theme: "dark" | "light";
  readonly locale: string;
}

export interface DesignWindowBridge {
  readonly context: DesignWindowContext;
  currentConversation(): Promise<DesignWindowConversation>;
  onConversation(
    listener: (conversation: DesignWindowConversation) => void,
  ): () => void;
  read(): Promise<BlankArtifactDocument>;
  save(
    input: Pick<SaveBlankArtifactInput, "content" | "expectedRevision">,
  ): Promise<SaveBlankArtifactResult>;
}

export const designWindowArgument = "--claudex-design-window=";
export const designWindowChannels = {
  currentConversation: "design-window:current-conversation",
  conversation: "design-window:conversation",
  read: "design-window:read",
  save: "design-window:save",
};
