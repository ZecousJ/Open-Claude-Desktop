package com.claudex.mobile

import android.app.Application
import androidx.lifecycle.ViewModelProvider

/** Construction-only seam. The normal Application does not implement the owner below. */
internal fun interface AppNativeApiFactory {
    fun create(app: Application): NativeApi
}

/**
 * Ownership is fixed by the Application instantiated for this process, never an Intent,
 * endpoint preference, static registry, or post-construction ViewModel mutation.
 */
internal interface AppViewModelFactoryOwner {
    val appViewModelFactory: ViewModelProvider.Factory
}
