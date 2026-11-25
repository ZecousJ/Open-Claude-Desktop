package com.claudex.mobile

import android.app.Application
import android.os.Looper
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider

/**
 * Lives only in the signed androidTest APK. No production manifest names this class.
 * One fixture binding per instrumentation process; run each selected case separately.
 * No Application.onCreate override: the real manifest currently uses plain Application.
 */
internal class LoopbackFixtureApplication : Application(), AppViewModelFactoryOwner {
    private var binding: ViewModelProvider.Factory? = null
    internal var createdModels: Int = 0
        private set

    override val appViewModelFactory: ViewModelProvider.Factory
        get() = requireNotNull(binding) {
            "Loopback fixture must be installed before MainActivity creates AppViewModel"
        }

    /** Call on the main thread before ActivityScenario.launch; never replace a live binding. */
    internal fun installOnce(apiFactory: AppNativeApiFactory) {
        check(Looper.myLooper() == Looper.getMainLooper())
        check(binding == null && createdModels == 0) { "One fixture per instrumentation process" }
        check(!BuildConfig.DEMO_MODE)
        // Each reviewed fixture owns its closed TLS/origin/store policy. The factory cannot
        // be supplied through args/Intents, and is never replaceable after installation.
        binding = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                check(Looper.myLooper() == Looper.getMainLooper())
                require(modelClass == AppViewModel::class.java) { "Unexpected ViewModel type" }
                val model = AppViewModel(this@LoopbackFixtureApplication, apiFactory)
                createdModels++
                @Suppress("UNCHECKED_CAST")
                return model as T
            }
        }
    }
}
