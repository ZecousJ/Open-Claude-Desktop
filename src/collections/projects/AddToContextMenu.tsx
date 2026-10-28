import { PageMenu } from "../PageMenu";
import { Paperclip, TextCursorInput, Github, Plug } from "../../ui/glyphs";
import { StarterCategoryIcon } from "../../starter-prompts/StarterCategoryIcon";

// The Drive mark keeps its own 14px size, whatever the menu passes.
const DriveMark = () => <StarterCategoryIcon icon="drive" />;

/** What AddToContextMenu needs from ProjectKnowledgeView.tsx. */
export interface ProjectKnowledgePart1Props {
  addButton: React.RefObject<HTMLButtonElement | null>;
  driveServers: string[];
  mcpServers: string[];
  repositories: string[];
  setDrive: React.Dispatch<React.SetStateAction<boolean>>;
  setGithub: React.Dispatch<React.SetStateAction<boolean>>;
  setMcpServer: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setWriting: React.Dispatch<React.SetStateAction<boolean>>;
  uploadInput: React.RefObject<HTMLInputElement | null>;
}

export function AddToContextMenu({
  addButton,
  driveServers,
  mcpServers,
  repositories,
  setDrive,
  setGithub,
  setMcpServer,
  setMenu,
  setWriting,
  uploadInput,
}: ProjectKnowledgePart1Props) {
  return (
    <PageMenu
      label="Add to context"
      width={182}
      anchor={addButton}
      onClose={() => setMenu(false)}
      entries={[
        {
          label: "Upload from device",
          icon: Paperclip,
          onSelect: () => uploadInput.current?.click(),
        },
        {
          label: "Add text content",
          icon: TextCursorInput,
          onSelect: () => setWriting(true),
        },
        ...(repositories.length
          ? [
              { separator: true as const },
              {
                label: "GitHub",
                icon: Github,
                onSelect: () => setGithub(true),
              },
            ]
          : []),
        ...(driveServers.length
          ? [
              {
                label: "Google Drive",
                icon: DriveMark,
                onSelect: () => setDrive(true),
              },
            ]
          : []),
        // One entry per connected MCP server with resources.
        ...mcpServers
          .filter((server) => !driveServers.includes(server))
          .map((server) => ({
            label: server,
            icon: Plug,
            onSelect: () => setMcpServer(server),
          })),
      ]}
    />
  );
}
