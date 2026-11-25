package com.claudex.mobile

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.claudex.core.*

@Composable fun DeleteConversationDialog(vm: AppViewModel, conversation: Conversation, dismiss: () -> Unit, deleted: () -> Unit) {
    val operations by vm.conversationActions.collectAsStateWithLifecycle()
    val working = conversation.id in operations
    ClaudeDialog(androidx.compose.ui.res.stringResource(if (conversation.mode == Mode.CODE) R.string.session_menu_delete_dialog_title else R.string.chat_menu_delete_conversation_dialog_title), androidx.compose.ui.res.stringResource(R.string.delete_dialog_default_subtitle),
        androidx.compose.ui.res.stringResource(R.string.generic_button_delete), { vm.deleteConversation(conversation) { dismiss(); deleted() } }, dismiss, destructive = true, busy = working)
}
