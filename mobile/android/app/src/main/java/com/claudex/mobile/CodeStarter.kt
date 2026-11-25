package com.claudex.mobile

import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * The Code starter page of the official Claude Android app 1.260923.20 (`uzr`, project list `ozr`): a greeting,
 * "Get started with a prompt", three suggestion pills (emoji, title, check when chosen), "Something else…" with a
 * free prompt box, a full-width Start Session and the link to your own repository. The prompts are the official
 * English text (they go to the model, they are not app copy) and equal shared/code-starter.ts in the main repository.
 */
internal data class CodeStarterSuggestion(val id: String, val emoji: String, @StringRes val title: Int, val prompt: String)

internal object CodeStarterPolicy {
    const val OTHER = "other"
    val suggestions = listOf(
        CodeStarterSuggestion("space-invaders", "🎮", R.string.code_starter_project_space_invaders,
            "Build me a small, self-contained Space Invaders game I can play right in my browser. Make it visually polished and mobile-friendly — a single index.html with no dependencies."),
        CodeStarterSuggestion("flashcard-study", "💬", R.string.code_starter_project_flashcards,
            "Build a simple flashcard study tool with flip-to-reveal cards and a progress counter. Single index.html, mobile-friendly, seed it with a few example cards so I can try it immediately."),
        CodeStarterSuggestion("todo-list", "📝", R.string.code_starter_project_todo,
            "Build a clean, minimalist todo list with add, complete, and delete. Single index.html, mobile-friendly, no dependencies. Make it look polished — nice typography and subtle animations."),
    )

    /** The prompt a choice puts in the draft: a card's own prompt; "Something else…" starts empty. */
    fun draftFor(choice: String?): String = suggestions.find { it.id == choice }?.prompt.orEmpty()

    /** The choice after a tap on [tapped] while [current] is chosen; tapping the chosen one again clears it. */
    fun next(current: String?, tapped: String): String? = if (current == tapped) null else tapped

    /** The draft after the choice moved to [to]: a card's prompt replaces an empty draft or the previous card's; typed text stays. */
    fun draftAfter(draft: String, to: String?): String {
        val untouched = draft.isBlank() || suggestions.any { it.prompt == draft }
        return if (untouched) draftFor(to) else draft
    }

    /** Start Session needs a choice and a prompt. */
    fun canStart(draft: String, choice: String?) = choice != null && draft.isNotBlank()
}

/** The pill (`sdx.d`): 28 dp corners, 18 × 16 dp padding, 12 dp gaps, emoji 18 sp, label filling, a check when chosen. */
@Composable private fun StarterPill(emoji: String, label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = Claude.colors
    val shape = RoundedCornerShape(28.dp)
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp).clip(shape)
        .background(if (selected) c.accentMain100.copy(alpha = .1f) else c.bg000)
        .border(BorderStroke(1.dp, if (selected) c.accentMain100 else c.border300), shape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(horizontal = 18.dp, vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(emoji, style = Claude.type.body17)
        Text(label, Modifier.weight(1f), style = Claude.type.body15, color = if (selected) c.accentMain100 else c.text300)
        Icon(Anthropicons.check, null, Modifier.size(22.dp).alpha(if (selected) 1f else 0f), tint = c.accentMain100)
    }
}

/** The starter's body. [choice] is a suggestion id, [CodeStarterPolicy.OTHER] or null (nothing chosen: the composer below stays). */
@Composable internal fun CodeStarter(name: String?, choice: String?, draft: String, onChoose: (String) -> Unit, onDraft: (String) -> Unit, busy: Boolean) {
    val c = Claude.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
        ClaudeGreeting(Modifier.padding(top = 8.dp), text = name?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.code_starter_greeting_named, it) } ?: stringResource(R.string.code_starter_greeting))
        Text(stringResource(R.string.code_starter_subtitle), Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp), style = Claude.type.body15, color = c.text500, textAlign = TextAlign.Center)
        CodeStarterPolicy.suggestions.forEach { item ->
            StarterPill(item.emoji, stringResource(item.title), choice == item.id, !busy) { onChoose(item.id) }
        }
        StarterPill("❓", stringResource(R.string.code_starter_something_else), choice == CodeStarterPolicy.OTHER, !busy) { onChoose(CodeStarterPolicy.OTHER) }
        if (choice == CodeStarterPolicy.OTHER) ClaudeTextField(draft, onDraft, Modifier.fillMaxWidth().padding(vertical = 6.dp), singleLine = false, minLines = 3, maxLines = 8, enabled = !busy,
            placeholder = stringResource(R.string.code_starter_custom_prompt_hint), shape = RoundedCornerShape(12.dp), container = c.bg000, border = c.border300,
            contentPadding = PaddingValues(12.dp))
    }
}
