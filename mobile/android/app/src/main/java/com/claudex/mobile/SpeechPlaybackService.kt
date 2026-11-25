package com.claudex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder

/** Lock-screen control for the utterance that is already speaking. Stop ends that utterance. */
internal object SpeechPlayback {
    var onStop: (() -> Unit)? = null

    fun present(context: Context) {
        val app = context.applicationContext
        runCatching { app.startForegroundService(Intent(app, SpeechPlaybackService::class.java)) }
    }

    fun dismiss(context: Context) {
        val app = context.applicationContext
        app.stopService(Intent(app, SpeechPlaybackService::class.java))
    }
}

internal class SpeechPlaybackService : Service() {
    private var session: MediaSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = notification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTICE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTICE, notification)
        publish()
        if (intent?.action == ACTION_STOP) {
            SpeechPlayback.onStop?.invoke()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        SpeechPlayback.onStop?.invoke()
        stopSelf()
    }

    override fun onDestroy() {
        session?.release()
        session = null
        super.onDestroy()
    }

    private fun publish() {
        if (session != null) return
        val created = MediaSession(this, "claudex-reading")
        created.setCallback(object : MediaSession.Callback() {
            override fun onStop() {
                SpeechPlayback.onStop?.invoke()
                stopSelf()
            }
        })
        created.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, getString(R.string.speech_reading_title)).build())
        created.setPlaybackState(
            PlaybackState.Builder()
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .setActions(PlaybackState.ACTION_STOP)
                .build(),
        )
        created.isActive = true
        session = created
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.speech_reading_aloud), NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(
            this,
            0,
            Intent(this, SpeechPlaybackService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.speech_reading_title))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, getString(R.string.speech_reading_stop), stop).build())
            .build()
    }

    private companion object {
        const val NOTICE = 501
        const val CHANNEL = "reading-aloud"
        const val ACTION_STOP = "com.claudex.mobile.SPEECH_STOP"
    }
}
