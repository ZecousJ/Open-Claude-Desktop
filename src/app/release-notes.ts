/** What's new entries, newest first. Only changes that shipped in Claudex. */
export type ReleaseNotes = {
  version: string;
  date: string;
  sections: { title: "New" | "Improved" | "Fixed"; items: string[] }[];
};

export const releaseNotes: ReleaseNotes[] = [
  {
    version: "0.0.1",
    date: "September 25, 2026",
    sections: [
      {
        title: "New",
        items: [
          "Keyboard shortcuts list, from the Help menu or Cmd+/ (Ctrl+/ on Windows).",
          "Rename a conversation in place from its sidebar menu, which also opens with a right-click.",
          "Filter the sidebar by type, status and last activity, and sort it by name, date created or last activity.",
          "Chat font, reduced motion and a custom code font in Settings.",
        ],
      },
      {
        title: "Improved",
        items: [
          "Settings save as soon as you change them.",
          "The application menu now lists New Chat, Toggle Sidebar, Search and zoom controls.",
          "Pinned and recent conversations are listed per surface: Chat and Cowork share one list and Code has its own.",
        ],
      },
    ],
  },
];
