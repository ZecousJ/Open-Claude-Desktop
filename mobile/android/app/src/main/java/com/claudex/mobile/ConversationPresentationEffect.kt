package com.claudex.mobile

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import com.claudex.core.Conversation
import com.claudex.core.Snapshot
import org.json.JSONArray

/** Read every input in composition. SideEffect only publishes the captured immutable value. */
@Composable internal fun PublishConversationPresentation(
    conversation: Conversation,
    dark: Boolean,
    snapshot: State<Snapshot>,
    busy: State<Boolean>,
    operations: State<Set<String>>,
    media: State<ConversationMedia>,
    document: ConversationDocument?,
    publish: (ConversationPresentation) -> Unit,
) {
    val currentSnapshot = snapshot.value
    val currentBusy = busy.value
    val currentOperations = operations.value
    val currentMedia = media.value
    val feedback = currentSnapshot.replyFeedback.filterKeys { key ->
        runCatching { JSONArray(key).getString(0) == conversation.id }.getOrDefault(false)
    }
    val presentation = ConversationPresentation(
        conversation, dark, feedback, currentBusy || conversation.id in currentOperations, document, currentMedia,
    )
    // Structurally equal values are deduplicated by the native delivery controller.
    SideEffect { publish(presentation) }
}
