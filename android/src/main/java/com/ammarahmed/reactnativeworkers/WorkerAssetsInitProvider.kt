package com.ammarahmed.reactnativeworkers

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/**
 * Captures the application context so release worker bundles can be read from
 * the APK with **no app-side setup**.
 *
 * This is the standard androidx-style initialization trick: a ContentProvider
 * declared in the library manifest is created by the system during application
 * startup, before any React Native code runs, and `getContext()` gives us the
 * application context. It is the only reliable way to get a Context without
 * asking the app to call an initializer — which bundled workers should not need,
 * since they are resolved by the C++ core rather than by app code.
 *
 * It provides no data; every ContentProvider method is a no-op.
 */
internal class WorkerAssetsInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    context?.let { WorkerAssets.initialize(it) }
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?
  ): Int = 0
}
