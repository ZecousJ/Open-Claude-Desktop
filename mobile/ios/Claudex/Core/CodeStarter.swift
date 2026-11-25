import Foundation

/// The Code starter page of the official Claude Android app 1.260923.20 (`uzr`, project list `ozr`): a greeting,
/// "Get started with a prompt", three suggestion pills (emoji, title, check when chosen), "Something else…" with a
/// free prompt box, a full-width Start Session and the link to your own repository. The prompts are the official
/// English text (they go to the model, they are not app copy) and equal shared/code-starter.ts in the main repository.
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
            prompt: "Build me a small, self-contained Space Invaders game I can play right in my browser. Make it visually polished and mobile-friendly — a single index.html with no dependencies."),
        CodeStarterSuggestion(id: "flashcard-study", emoji: "💬", titleKey: "code_starter_project_flashcards",
            prompt: "Build a simple flashcard study tool with flip-to-reveal cards and a progress counter. Single index.html, mobile-friendly, seed it with a few example cards so I can try it immediately."),
        CodeStarterSuggestion(id: "todo-list", emoji: "📝", titleKey: "code_starter_project_todo",
            prompt: "Build a clean, minimalist todo list with add, complete, and delete. Single index.html, mobile-friendly, no dependencies. Make it look polished — nice typography and subtle animations."),
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
