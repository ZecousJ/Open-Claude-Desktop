package com.claudex.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import com.claudex.core.Conversation
import org.json.JSONArray
import org.json.JSONObject

/** Home-screen titles for pinned and recent chats. A tap opens that chat and does not send. */
internal object ChatWidgetRows {
    private const val PREF = "widget-chats"
    private val rows = intArrayOf(R.id.widget_row_0, R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3)

    fun publish(context: Context, conversations: List<Conversation>) {
        val chosen = conversations.filter { !it.archived }
            .sortedWith(compareByDescending<Conversation> { it.pinned }.thenByDescending { it.updatedAt })
            .take(rows.size)
        val array = JSONArray()
        for (conversation in chosen) {
            array.put(JSONObject().put("id", conversation.id).put("title", conversation.title.take(80)))
        }
        context.getSharedPreferences("preferences", 0).edit().putString(PREF, array.toString()).apply()
        refresh(context)
    }

    fun clear(context: Context) {
        context.getSharedPreferences("preferences", 0).edit().remove(PREF).apply()
        refresh(context)
    }

    fun refresh(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val ids = manager.getAppWidgetIds(ComponentName(context, ChatWidget::class.java))
        for (id in ids) manager.updateAppWidget(id, views(context))
    }

    fun views(context: Context): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.chat_widget)
        views.setOnClickPendingIntent(R.id.widget_new, open(context, "claudex://new", 1))
        val stored = context.getSharedPreferences("preferences", 0).getString(PREF, null)
        val items = runCatching { JSONArray(stored ?: "[]") }.getOrDefault(JSONArray())
        for (index in rows.indices) {
            if (index >= items.length()) {
                views.setViewVisibility(rows[index], View.GONE)
                continue
            }
            val item = items.optJSONObject(index)
            val id = item?.optString("id").orEmpty()
            val title = item?.optString("title").orEmpty().ifBlank { context.getString(R.string.generic_untitled) }
            views.setViewVisibility(rows[index], View.VISIBLE)
            views.setTextViewText(rows[index], title)
            if (id.matches(Regex("^[A-Za-z0-9_-]{1,128}$"))) views.setOnClickPendingIntent(rows[index], open(context, "claudex://chat/$id", 2 + index))
        }
        return views
    }

    private fun open(context: Context, link: String, request: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW).setData(Uri.parse(link)).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

internal class ChatWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) appWidgetManager.updateAppWidget(id, ChatWidgetRows.views(context))
    }
}
