package com.ammarahmed.reactnativeworkers

import android.content.Context
import android.content.res.AssetManager
import java.io.IOException

/**
 * Reads release worker bundles out of the APK's assets.
 *
 * The release CLI emits `workers/<sanitized-id>.jsbundle` and the Gradle task
 * (`android/worker-bundles.gradle`) copies them into `src/main/assets/workers/`,
 * so the asset name the C++ core asks for is already the asset path.
 *
 * A bundle may be Hermes bytecode rather than JS — this returns raw bytes and
 * Hermes detects the format when it evaluates them.
 *
 * The [AssetManager] is captured from the application context the first time the
 * library's native code initializes; there is no app-side setup to do.
 */
internal object WorkerAssets {
  @Volatile private var assets: AssetManager? = null

  /** Called by [ReactNativeWorkersPackage] as soon as a context is available. */
  @JvmStatic
  fun initialize(context: Context) {
    if (assets == null) {
      assets = context.applicationContext.assets
    }
  }

  /**
   * Returns the bytes of [name], or null if it is missing/unreadable. Called
   * from C++ on whatever thread is creating the worker.
   */
  @JvmStatic
  fun read(name: String): ByteArray? {
    val am = assets ?: return null
    return try {
      am.open(name).use { it.readBytes() }
    } catch (e: IOException) {
      null
    }
  }
}
