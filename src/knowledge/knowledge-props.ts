import type { KnowledgeBaseInfo } from "../../shared/knowledge-api";

/** What the composer's "+" menus need for the knowledge rows. */
export interface KnowledgeProps {
  bases: KnowledgeBaseInfo[];
  /** The bases this chat (or the new chat's draft) uses. */
  active: readonly string[];
  onToggle: (id: string) => void;
}
