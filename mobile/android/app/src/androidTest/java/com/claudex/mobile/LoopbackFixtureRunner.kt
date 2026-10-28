package com.claudex.mobile

import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.test.runner.AndroidJUnitRunner
import java.io.File
import java.security.MessageDigest

/**
 * androidTest-only runner. Substitution precedes Activity and ViewModel construction.
 * This runner is selected only by the isolated test build; the production manifest and
 * normal launcher path remain unchanged. Android itself enforces instrumentation signing.
 */
class LoopbackFixtureRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader, className: String, context: Context): Application {
        // If production later gains an Application subclass, do not silently skip its lifecycle.
        check(className == Application::class.java.name) {
            "Production Application changed; preserve its initialization before updating this runner"
        }
        check(context.packageName == "com.claudex.mobile" && !BuildConfig.DEMO_MODE)
        // No network or NativeApi is created here. Missing binding fails closed on VM access.
        return super.newApplication(cl, LoopbackFixtureApplication::class.java.name, context)
    }

    override fun onCreate(arguments: Bundle) {
        check(arguments.getString("qaFixtureOnly") == "true")
        check(arguments.getString("qaLoopbackTransport") == "true")
        check((arguments.getString("qaWebHostProbe") ?: "readOnly") == "readOnly")
        val selected = arguments.getString("class").orEmpty()
        check(selected in setOf(
            "com.claudex.mobile.ProductionAuthObserverContractTest#normalCollectorsObserveInstructionsAndServerSignOut",
            "com.claudex.mobile.ProductionTransportNormalDispatchTest#ordinaryDispatcherComposerStreamsAndSharedRetryOverTls"
        )) {
            "Select one reviewed pre-construction fixture method; add future cases explicitly"
        }
        val manager = targetContext.packageManager
        val info = manager.getInstrumentationInfo(componentName, 0)
        check(componentName.className == LoopbackFixtureRunner::class.java.name)
        check(info.targetPackage == "com.claudex.mobile")
        check(manager.checkSignatures(info.packageName, info.targetPackage) == PackageManager.SIGNATURE_MATCH) {
            "Fixture instrumentation and target must have matching signing identity"
        }
        val expected = arguments.getString("expectedApkSha256").orEmpty().lowercase()
        check(expected.matches(Regex("[0-9a-f]{64}"))) { "Exact installed target APK SHA-256 required" }
        check(sha256(File(targetContext.applicationInfo.sourceDir)) == expected) { "Installed target APK mismatch" }
        val originHash = digest(BuildConfig.SERVER_ORIGIN.trimEnd('/').toByteArray())
        check(!targetContext.getSharedPreferences("session-$originHash", 0).contains("encrypted")) {
            "Existing account storage: use a clean disposable emulator; do not load or delete it"
        }
        // All guards precede test execution. Only the selected test installs a fixture binding.
        super.onCreate(arguments)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
}
