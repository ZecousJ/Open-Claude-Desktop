import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";

/** Opt-in synthetic records for inspecting the real conditional carousel.
 * Their declared members are other public fixture records. No official bundle
 * membership, artwork, publisher identity or connection capability is implied. */
export function fixtureConnectorCuration(): ApprovedDirectoryEntry[] {
  return [
    ["research", "Research", "Explore the fixture research connector", "Inspect this test connector’s published feature and directory detail."],
    ["notes", "Notes", "Organize notes with a test connector", "A synthetic feature for checking carousel text, controls, and navigation."],
    ["planning", "Planning", "Try the fixture planning connector", "Use this test record to inspect the third slide and its actual detail page."],
  ].map<ApprovedDirectoryEntry>(([id, name, title, subtitle], index, records) => ({
    id: `fixture-curation-${id}`,
    kind: "mcp",
    name: `Fixture ${name} Connector`,
    description: `Synthetic ${name.toLowerCase()} connector for offline visual review.`,
    author: "Fixture directory publisher",
    url: `https://fixture-${id}.example.test/mcp`,
    added: "2026-10-19",
    curation: {
      relatedIds: records.filter((_, other) => other !== index).map(([otherId]) => `fixture-curation-${otherId}`),
      featured: {
        title, subtitle, curator: "Fixture directory curator",
        memberIds: [`fixture-curation-${id}`, `fixture-curation-${records[(index + 1) % records.length][0]}`],
      },
    },
  }));
}
