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
import java.util.Collections

/** A scheduled task the app has just heard finished or failed. Tapping it opens that run's conversation. */
internal object ScheduleNotifications {
    private const val CHANNEL = "schedules"
    private val posted = Collections.synchronizedSet(mutableSetOf<String>())

    fun show(context: Context, notice: ScheduleNotice) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = if (notice.completed) "schedules-quiet" else CHANNEL
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(channel) == null) {
            val created = NotificationChannel(channel, context.getString(R.string.scheduled_tasks_notification_title), if (notice.completed) NotificationManager.IMPORTANCE_LOW else NotificationManager.IMPORTANCE_DEFAULT)
            if (notice.completed) created.setSound(null, null)
            manager.createNotificationChannel(created)
        }
        val open = PendingIntent.getActivity(
            context,
            notice.conversationId.hashCode(),
            Intent(context, MainActivity::class.java).putExtra(ReplyNotifications.CONVERSATION, notice.conversationId).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel) else Notification.Builder(context)
        val title = context.getString(if (notice.completed) R.string.scheduled_task_notice_completed else R.string.scheduled_task_notice_failed)
        val body = notice.body.ifBlank { context.getString(R.string.scheduled_task_fallback) }
        if (!notice.completed && Build.VERSION.SDK_INT < 26) builder.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI)
        manager.notify(("schedule-${notice.conversationId}").hashCode(), builder
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build())
        posted.add(notice.conversationId)
    }

    fun clear(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (id in posted.toList()) manager.cancel(("schedule-$id").hashCode())
        posted.clear()
    }
}
