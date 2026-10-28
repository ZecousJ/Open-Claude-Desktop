package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject

/** How a Manage-memory change went (shared/memory-api.ts MemoryEditOutcome); [removed] names the statements that went. */
internal data class MemoryEditOutcome(val kind: String, val removed: List<String> = emptyList()) {
    /** Nothing was saved: memory refused the text (a secret, or longer than a memory edit may be). */
    val refused get() = kind == "rejected" || kind == "too_long"
    companion object {
        /** The service of this app's version answers an outcome; one from before it did not, so the change is worded by what was asked. */
        fun from(value: JSONObject?, asked: Boolean): MemoryEditOutcome {
            val kind = value?.optString("kind").orEmpty()
            val removed = value?.optJSONArray("removed")?.let { names -> (0 until names.length()).map { names.optString(it) } }.orEmpty()
            return if (kind.isNotEmpty()) MemoryEditOutcome(kind, removed) else MemoryEditOutcome(if (asked) "added" else "removed")
        }
    }
}

/** The scope's memory after a change (null when it has none) and how the change went. */
internal class MemoryEditResult(val document: JSONObject?, val outcome: MemoryEditOutcome) {
    companion object {
        fun from(result: JSONObject, asked: Boolean): MemoryEditResult {
            val outcome = MemoryEditOutcome.from(result.optJSONObject("outcome"), asked)
            // A scope left without memory answers an empty document.
            val empty = (result.optJSONArray("edits") ?: JSONArray()).length() == 0 && result.optString("content").isBlank()
            return MemoryEditResult(if (empty) null else JSONObject(result.toString()).also { it.remove("outcome") }, outcome)
        }
    }
}

/**
 * The line that says how a Manage-memory change went, as the official app words it. More than three names
 * are counted ("4 memory files"); Claudex keeps statements where the original names memory files.
 */
internal object MemoryEditLine {
    fun text(outcome: MemoryEditOutcome): String = when (outcome.kind) {
        "added" -> UserText.get(R.string.memory_edit_result_added)
        "updated" -> UserText.get(R.string.memory_edit_result_updated)
        "noop" -> UserText.get(R.string.memory_edit_result_noop)
        // The text field already stops at the length memory allows, so a too-long edit reads as a refusal.
        "rejected", "too_long" -> UserText.get(R.string.memory_edit_rejected)
        "removed" -> UserText.get(R.string.memory_edit_result_removed, names(outcome.removed))
        // Android's official strings have no "Added to memory, removed …"; an added and removed pair reads as an update.
        else -> if (outcome.removed.isEmpty()) UserText.get(R.string.memory_edit_result_updated) else UserText.get(R.string.memory_edit_result_updated_removed, names(outcome.removed))
    }
    /** The result card: the line, then "Done." (the official card shows the model's text, or "Done." without one). */
    fun card(outcome: MemoryEditOutcome): String = text(outcome) + if (outcome.refused) "" else "\n" + UserText.get(R.string.memory_edit_result_done)
    private fun names(removed: List<String>): String =
        if (removed.size > 3) UserText.plural(R.plurals.memory_edit_many_files, removed.size, removed.size)
        else android.icu.text.ListFormatter.getInstance().format(removed)
}
