package com.claudex.mobile

import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.claudex.core.Connection
import com.claudex.core.CredentialStore
import com.claudex.core.Session
import com.claudex.core.TurnStatus
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

@RunWith(AndroidJUnit4::class)
class RealRunnerAndroidTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val ui by lazy { NativeTransportUiDriver(instrumentation) }
    private fun shellFile(path: String): String = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand("cat $path")
    ).bufferedReader().use { it.readText() }
    private fun await(predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 90_000
        while (SystemClock.elapsedRealtime() < deadline) { if (predicate()) return; Thread.sleep(100) }
        error("Timed out waiting for the Runner")
    }
    @Test fun stopAndReconnect() {
        val credentials = JSONObject(shellFile("/data/local/tmp/f088-android-account.json"))
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(shellFile("/data/local/tmp/f088-android-ca.crt").toByteArray()))
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("fixture", cert) }
        val manager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }.trustManagers.single() as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
        val client = OkHttpClient.Builder().dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                require(hostname == "localhost")
                return listOf(InetAddress.getByName("10.0.2.2"))
            }
        }).sslSocketFactory(ssl.socketFactory, manager).build()
        val vault = object : CredentialStore {
            private var value: Session? = null
            override fun load() = value
            override fun save(session: Session) { value = session }
            override fun clear() { value = null }
        }
        val app = instrumentation.targetContext.applicationContext as LoopbackFixtureApplication
        instrumentation.runOnMainSync { app.installOnce(AppNativeApiFactory { NativeApi("https://localhost:48985", vault, client) }) }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            lateinit var model: AppViewModel
            scenario.onActivity { model = ViewModelProvider(it)[AppViewModel::class.java] }
            await { ui.hasText("为解决问题的人打造的 AI") }
            ui.input("输入你的邮箱", credentials.getString("email"))
            ui.touch("使用邮箱继续", description = true)
            await { ui.hasText("输入密码") }
            ui.input("输入密码", credentials.getString("password"))
            ui.touch("继续", description = true)
            await { model.connection.value is Connection.Connected && model.snapshot.value.conversations.any { it.title == "F088SEEDANDROID" } }
            ui.touch("打开菜单", description = true)
            ui.revealForTouch("F088SEEDANDROID")
            ui.touch("F088SEEDANDROID")
            val id = model.snapshot.value.conversations.first { it.title == "F088SEEDANDROID" }.id
            fun turn() = model.snapshot.value.conversations.firstOrNull { it.id == id }?.turns?.lastOrNull()
            ui.syntheticComposerInput("F088STOPNATIVE02")
            ui.touch("发送", description = true)
            await { turn()?.let { it.prompt.contains("F088STOPNATIVE02") && it.status == TurnStatus.IN_PROGRESS && it.items.any { item -> item.type == "commandExecution" } } == true }
            Thread.sleep(3_000)
            ui.touch("停止回复", description = true)
            await { turn()?.status == TurnStatus.INTERRUPTED }
            fun control(path: String) { client.newCall(Request.Builder().url("https://localhost:48985$path").post(okhttp3.RequestBody.create(null, ByteArray(0))).build()).execute().use { check(it.isSuccessful) } }
            control("/__fixture/disconnect-events?tab=${model.api.tabId}&hold=1")
            await { model.connection.value !is Connection.Connected }
            control("/__fixture/restore-events?tab=${model.api.tabId}")
            await { model.connection.value is Connection.Connected }
            ui.syntheticComposerInput("F088FOLLOWNATIVE02")
            ui.touch("发送", description = true)
            await { turn()?.let { it.prompt.contains("F088FOLLOWNATIVE02") && it.status == TurnStatus.COMPLETED } == true }
        } finally {
            scenario.close()
            client.dispatcher.executorService.shutdownNow()
        }
    }
    @Test fun remoteDeviceStop() {
        val credentials = JSONObject(shellFile("/data/local/tmp/f088-android-account.json"))
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(shellFile("/data/local/tmp/f088-android-ca.crt").toByteArray()))
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("fixture", cert) }
        val manager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }.trustManagers.single() as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
        val client = OkHttpClient.Builder().dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                require(hostname == "localhost")
                return listOf(InetAddress.getByName("10.0.2.2"))
            }
        }).sslSocketFactory(ssl.socketFactory, manager).build()
        val vault = object : CredentialStore {
            private var value: Session? = null
            override fun load() = value
            override fun save(session: Session) { value = session }
            override fun clear() { value = null }
        }
        val app = instrumentation.targetContext.applicationContext as LoopbackFixtureApplication
        instrumentation.runOnMainSync { app.installOnce(AppNativeApiFactory { NativeApi("https://localhost:48985", vault, client) }) }
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            lateinit var model: AppViewModel
            scenario.onActivity { model = ViewModelProvider(it)[AppViewModel::class.java] }
            await { ui.hasText("为解决问题的人打造的 AI") }
            ui.input("输入你的邮箱", credentials.getString("email"))
            ui.touch("使用邮箱继续", description = true)
            await { ui.hasText("输入密码") }
            ui.input("输入密码", credentials.getString("password"))
            ui.touch("继续", description = true)
            await { model.connection.value is Connection.Connected }
            val deviceClient = DeviceClient(model.api)
            val device = kotlinx.coroutines.runBlocking { deviceClient.devices().single() }
            val id = kotlinx.coroutines.runBlocking { deviceClient.newSession(device.id, "/private/tmp/f088-paired-workspace", "F088STOPDEVICE04") }
            ui.touch("打开菜单", description = true)
            ui.touch("代码")
            await { model.devices.devices.value.any { it.id == device.id } }
            ui.touchVisibleCenter(device.name)
            await { model.devices.conversations.value[device.id]?.any { it.id == id } == true }
            ui.revealForTouch("F088STOPDEVICE04")
            ui.touch("F088STOPDEVICE04")
            await { model.devices.open.value?.let { it.conversation.id == id && it.running && it.conversation.turns.last().items.any { item -> item.type == "commandExecution" } } == true }
            Thread.sleep(3_000)
            ui.touch("停止", description = true)
            await { model.devices.open.value?.let { it.conversation.id == id && it.conversation.turns.last().status == TurnStatus.INTERRUPTED } == true }
        } finally {
            scenario.close()
            client.dispatcher.executorService.shutdownNow()
        }
    }
}
