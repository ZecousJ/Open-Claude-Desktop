package com.claudex.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.claudex.core.Approval
import java.util.Collections

/**
 * A tool approval that arrived while the app was in the background.
 * Allow once and Decline send the same answer as the card. A form or a question only opens the chat.
 */
internal object ApprovalNotifications {
    const val APPROVAL = "claudex.approval"
    const val ALLOW = "com.claudex.mobile.APPROVAL_ALLOW"
    const val DENY = "com.claudex.mobile.APPROVAL_DENY"
    private const val CHANNEL = "approvals"
    private val posted = Collections.synchronizedSet(mutableSetOf<String>())
    @Volatile var model: AppViewModel? = null

    fun sync(context: Context, approvals: List<Approval>, titles: Map<String, String>, schedules: List<org.json.JSONObject>?, background: Boolean) {
        val current = approvals.map { it.id }.toSet()
        for (id in posted.toList()) if (id !in current) {
            cancel(context, id)
            posted.remove(id)
        }
        if (!background || !ReplyNotifications.enabled(context)) return
        for (approval in approvals) {
            if (posted.contains(approval.id)) continue
            val task = schedules?.find { it.optString("conversationId") == approval.conversationId && it.optString("lastRunStatus") in setOf("starting", "running") }?.optString("name")?.trim()?.take(80)
            if (show(context, approval, titles[approval.conversationId].orEmpty(), task)) posted.add(approval.id)
        }
    }

    fun clear(context: Context) {
        for (id in posted.toList()) cancel(context, id)
        posted.clear()
    }

    fun cancel(context: Context, id: String) {
        context.getSystemService(NotificationManager::class.java).cancel(notificationId(id))
    }

    private fun show(context: Context, approval: Approval, conversationTitle: String, taskName: String?): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.claudex_approval_waiting), NotificationManager.IMPORTANCE_HIGH))
        }
        val open = openChat(context, approval, 0)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
        val title = if (!taskName.isNullOrBlank()) context.getString(R.string.scheduled_task_needs_approval) else context.getString(R.string.claudex_approval_waiting)
        val body = if (!taskName.isNullOrBlank()) taskName else conversationTitle.ifBlank { context.getString(R.string.generic_untitled) }
        builder.setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
        if (ApprovalKinds.answerable(approval.method)) {
            builder.addAction(Notification.Action.Builder(null, context.getString(R.string.tool_approval_button_allow_once), action(context, approval, ALLOW, 1)).build())
            builder.addAction(Notification.Action.Builder(null, context.getString(R.string.tool_approval_button_decline), action(context, approval, DENY, 2)).build())
        }
        manager.notify(notificationId(approval.id), builder.build())
        return true
    }

    private fun openChat(context: Context, approval: Approval, slot: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(ReplyNotifications.CONVERSATION, approval.conversationId)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, notificationId(approval.id) + slot, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun action(context: Context, approval: Approval, name: String, slot: Int): PendingIntent {
        val intent = Intent(context, ApprovalActionReceiver::class.java).setAction(name).putExtra(APPROVAL, approval.id).putExtra(ReplyNotifications.CONVERSATION, approval.conversationId)
        return PendingIntent.getBroadcast(context, notificationId(approval.id) + slot, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun notificationId(id: String) = ("approval-$id").hashCode()
}

internal class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(ApprovalNotifications.APPROVAL) ?: return
        val model = ApprovalNotifications.model
        if (model == null) {
            context.startActivity(Intent(context, MainActivity::class.java)
                .putExtra(ReplyNotifications.CONVERSATION, intent.getStringExtra(ReplyNotifications.CONVERSATION))
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            return
        }
        val pending = goAsync()
        model.decideApproval(id, intent.action == ApprovalNotifications.ALLOW) { pending.finish() }
    }
}
