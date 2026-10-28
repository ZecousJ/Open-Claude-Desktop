import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationGroups } from "../../shared/collections-api";

/** The account's custom sidebar groups (Move to group, Group by → Custom groups). */
export const conversationGroupsName = "conversation-groups.json";
export const maxConversationGroups = 50;
export const maxGroupNameLength = 60;

const empty = (): ConversationGroups => ({ groups: [], members: {} });

/** A group name as typed: trimmed, 1–60 characters, no line breaks. */
export function groupName(value: unknown): string {
  const name =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new Error("Enter a group name.");
  if (name.length > maxGroupNameLength)
    throw new Error(
      `Group names can be up to ${maxGroupNameLength} characters.`,
    );
  return name;
}

function valid(value: unknown): value is ConversationGroups {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.groups) || data.groups.length > maxConversationGroups)
    return false;
  const ids = new Set<string>();
  for (const group of data.groups) {
    if (
      !group ||
      typeof group.id !== "string" ||
      !group.id ||
      group.id.length > 100 ||
      ids.has(group.id) ||
      typeof group.name !== "string" ||
      !group.name.trim() ||
      group.name.length > maxGroupNameLength
    )
      return false;
    ids.add(group.id);
  }
  const members = data.members;
  if (!members || typeof members !== "object" || Array.isArray(members))
    return false;
  return Object.entries(members).every(
    ([conversation, group]) =>
      conversation.length > 0 &&
      conversation.length <= 500 &&
      typeof group === "string" &&
      ids.has(group),
  );
}

/**
 * The groups file in the account's profile. Each call reads the file again,
 * so a handler never keeps one account's groups across a sign-out; writes go
 * through a temporary file and a rename. `known` is the set of conversation
 * ids that still exist: members of deleted conversations are dropped on the
 * next read or write.
 */
export class ConversationGroupStore {
  private readonly filename: string;
  constructor(
    root: string,
    private known: () => Iterable<string>,
  ) {
    this.filename = path.join(root, conversationGroupsName);
  }
  private read(): ConversationGroups {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new Error(
        "Your conversation groups couldn't be read. The file has not been overwritten.",
      );
    }
    if (!valid(data))
      throw new Error(
        "Your conversation groups couldn't be read. The file has not been overwritten.",
      );
    return {
      groups: data.groups.map(({ id, name }) => ({ id, name })),
      members: { ...data.members },
    };
  }
  /**
   * Drops members whose conversation was deleted. A group stays when nothing is
   * left in it.
   */
  private prune(data: ConversationGroups) {
    const known = new Set(this.known());
    let changed = false;
    for (const id of Object.keys(data.members))
      if (!known.has(id)) {
        delete data.members[id];
        changed = true;
      }
    return changed;
  }
  private write(data: ConversationGroups) {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filename);
    return structuredClone(data);
  }
  list(): ConversationGroups {
    const data = this.read();
    return this.prune(data) ? this.write(data) : data;
  }
  /**
   * Adds a group at the end. With a conversation (Move to group → New
   * group…) the conversation moves into it; without one (New group… on a
   * group's heading) the group starts empty.
   */
  create(name: unknown, conversationId?: string | null): ConversationGroups {
    const data = this.read();
    this.prune(data);
    const label = groupName(name);
    if (conversationId != null) this.conversation(conversationId);
    if (data.groups.length >= maxConversationGroups)
      throw new Error(`You can have up to ${maxConversationGroups} groups.`);
    if (
      data.groups.some(
        (group) => group.name.toLowerCase() === label.toLowerCase(),
      )
    )
      throw new Error(`A group named “${label}” already exists.`);
    const id = randomUUID();
    data.groups.push({ id, name: label });
    if (conversationId != null) data.members[conversationId] = id;
    return this.write(data);
  }
  /**
   * Moves a conversation into a group, or out of every group with null. A
   * group left empty stays.
   */
  move(conversationId: string, groupId: string | null): ConversationGroups {
    const data = this.read();
    this.prune(data);
    this.conversation(conversationId);
    if (groupId === null) delete data.members[conversationId];
    else {
      if (!data.groups.some((group) => group.id === groupId))
        throw new Error("This group no longer exists.");
      data.members[conversationId] = groupId;
    }
    return this.write(data);
  }
  /** Renames a group (Rename group on a group's heading); names stay unique. */
  rename(groupId: string, name: unknown): ConversationGroups {
    const data = this.read();
    this.prune(data);
    const label = groupName(name);
    const group = data.groups.find((value) => value.id === groupId);
    if (!group) throw new Error("This group no longer exists.");
    if (
      data.groups.some(
        (other) =>
          other.id !== groupId &&
          other.name.toLowerCase() === label.toLowerCase(),
      )
    )
      throw new Error(`A group named “${label}” already exists.`);
    group.name = label;
    return this.write(data);
  }
  /**
   * Deletes a group (Delete group on a group's heading): the conversations
   * in it stay and are ungrouped.
   */
  remove(groupId: string): ConversationGroups {
    const data = this.read();
    this.prune(data);
    if (!data.groups.some((group) => group.id === groupId))
      throw new Error("This group no longer exists.");
    data.groups = data.groups.filter((group) => group.id !== groupId);
    for (const [conversation, group] of Object.entries(data.members))
      if (group === groupId) delete data.members[conversation];
    return this.write(data);
  }
  private conversation(id: string) {
    if (![...this.known()].includes(id))
      throw new Error("Conversation not found.");
  }
}
