package com.uiworkerdemo

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/**
 * Tracks the foreground Activity so the platform layer has something to draw on.
 *
 * The obvious alternative — asking React Native for `currentActivity` — would
 * mean holding a ReactApplicationContext, and the only hooks that hand one over
 * (`getModule`, `createNativeModules`) are never called for a package that
 * registers no modules, which is exactly what this demo is. Activity lifecycle
 * callbacks are independent of React Native's lifecycle entirely, so there is
 * nothing to get wrong.
 *
 * The ContentProvider is the standard androidx-style init trick: the system
 * creates it during application startup, before any app code runs. It provides
 * no data; every ContentProvider method is a no-op.
 */
internal class UIWorkerDemoInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    val app = context?.applicationContext as? Application ?: return true
    app.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityResumed(activity: Activity) {
          UIWorkerDemoPlatform.setActivity(activity)
        }

        override fun onActivityPaused(activity: Activity) {
          UIWorkerDemoPlatform.clearActivity(activity)
        }

        override fun onActivityDestroyed(activity: Activity) {
          UIWorkerDemoPlatform.clearActivity(activity)
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

        override fun onActivityStarted(activity: Activity) = Unit

        override fun onActivityStopped(activity: Activity) = Unit

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      }
    )
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0
}
