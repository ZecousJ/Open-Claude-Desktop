import Foundation

/// The Code starter page: a greeting, "Get started with a prompt", three suggestion pills (emoji, title, check when
/// chosen), "Something else…" with a free prompt box, a full-width Start Session and the link to your own repository.
/// The prompts are kept in English (they go to the model, they are not app copy) and equal
/// shared/code-starter.ts in the main repository.
public struct CodeStarterSuggestion: Identifiable, Sendable, Equatable {
    public let id: String
    public let emoji: String
    /// The string key of the title the app shows.
    public let titleKey: String
    public let prompt: String
}

public enum CodeStarter {
    public static let other = "other"

    public static let suggestions: [CodeStarterSuggestion] = [
        CodeStarterSuggestion(id: "space-invaders", emoji: "🎮", titleKey: "code_starter_project_space_invaders",
            prompt: "Make a small arcade shooter in the spirit of Space Invaders that runs in a browser: one index.html, no libraries, keyboard and touch controls, and a tidy look that works on a phone."),
        CodeStarterSuggestion(id: "flashcard-study", emoji: "💬", titleKey: "code_starter_project_flashcards",
            prompt: "Make a flashcard app for studying: tapping a card turns it over to show the answer, a counter shows how far through the deck I am, and a handful of sample cards are included so it works straight away. Keep it to one index.html that works on a phone."),
        CodeStarterSuggestion(id: "todo-list", emoji: "📝", titleKey: "code_starter_project_todo",
            prompt: "Make a minimal to-do list where I can add items, tick them off and remove them. One index.html with no dependencies, careful typography and light animations, comfortable to use on a phone."),
    ]

    /// The prompt a choice puts in the draft: a card's own prompt; "Something else…" starts empty.
    public static func draft(for choice: String?) -> String { suggestions.first { $0.id == choice }?.prompt ?? "" }

    /// The choice after a tap on `tapped` while `current` is chosen; tapping the chosen one again clears it.
    public static func next(current: String?, tapped: String) -> String? { current == tapped ? nil : tapped }

    /// The draft after the choice moved to `choice`: a card's prompt replaces an empty draft or the previous card's; typed text stays.
    public static func draftAfter(_ draft: String, choice: String?) -> String {
        let untouched = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || suggestions.contains { $0.prompt == draft }
        return untouched ? Self.draft(for: choice) : draft
    }

    /// Start Session needs a choice and a prompt.
    public static func canStart(draft: String, choice: String?) -> Bool {
        choice != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
