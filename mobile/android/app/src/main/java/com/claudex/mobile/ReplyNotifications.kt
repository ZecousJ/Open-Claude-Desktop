package com.claudex.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/** A reply that finished while the app was in the background. Tapping it opens that conversation. */
internal object ReplyNotifications {
    const val CONVERSATION = "claudex.conversation"
    private const val PREF = "reply-notifications"
    private const val CHANNEL = "replies"

    fun enabled(context: Context) = context.getSharedPreferences("preferences", 0).getBoolean(PREF, true)

    fun setEnabled(context: Context, value: Boolean) {
        context.getSharedPreferences("preferences", 0).edit().putBoolean(PREF, value).apply()
    }

    fun show(context: Context, id: String, title: String) {
        if (!enabled(context)) return
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.chat_completion_notification_settings_title), NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = PendingIntent.getActivity(
            context,
            id.hashCode(),
            Intent(context, MainActivity::class.java).putExtra(CONVERSATION, id).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val body = title.ifBlank { context.getString(R.string.chat_completion_notification_settings_description) }
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
        manager.notify(id.hashCode(), builder
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(context.getString(R.string.chat_completion_notification_posted))
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build())
    }
}
