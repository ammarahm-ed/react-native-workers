package com.uiworkerdemo

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import java.lang.ref.WeakReference

/**
 * The Android half of the demo platform, called straight from C++ via fbjni.
 *
 * Every method runs SYNCHRONOUSLY on the caller's thread — there is no
 * `runOnUiThread` anywhere in this file, on purpose. The C++ layer
 * (`requireMainThread`) has already established that the caller is the main
 * thread, which is exactly what a UIWorker gives you: JS -> JSI -> C++ -> Android,
 * no dispatch and no serialization. Adding a post here would defeat the point of
 * the demo and hide the very cost it exists to show.
 */
object UIWorkerDemoPlatform {
  // Set from UIWorkerDemoInitProvider's Activity lifecycle callbacks. Weak so a
  // destroyed Activity is never held alive by us.
  @Volatile
  private var activityRef: WeakReference<Activity>? = null

  // An animation calls the view methods ~60x/second for the same tag, so cache
  // the last resolution instead of walking the hierarchy every frame. Held
  // weakly: we must not keep a view alive after React unmounts it.
  private var cachedView: WeakReference<View>? = null
  private var cachedTag: Int = 0

  @JvmStatic
  fun setActivity(activity: Activity) {
    activityRef = WeakReference(activity)
  }

  /** Only clears if [activity] is still the one we hold, so a resume/pause
   *  overlap between two Activities cannot drop the incoming one. */
  @JvmStatic
  fun clearActivity(activity: Activity) {
    if (activityRef?.get() === activity) {
      activityRef = null
      cachedView = null
    }
  }

  private fun activity(): Activity? = activityRef?.get()

  private fun context(): Context? = activity()

  @JvmStatic
  fun showAlert(title: String, message: String) {
    val activity = activity() ?: return
    AlertDialog.Builder(activity)
      .setTitle(title)
      .setMessage(message)
      .setPositiveButton("OK", null)
      .show()
  }

  @JvmStatic
  fun setStatusBarHidden(hidden: Boolean) {
    val window = activity()?.window ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = window.insetsController ?: return
      if (hidden) {
        controller.hide(WindowInsets.Type.statusBars())
      } else {
        controller.show(WindowInsets.Type.statusBars())
      }
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility =
        if (hidden) View.SYSTEM_UI_FLAG_FULLSCREEN else 0
    }
  }

  /**
   * Window-level brightness, the closest analogue to iOS's `UIScreen.brightness`.
   * Changing the SYSTEM brightness needs the WRITE_SETTINGS permission and a user
   * grant flow, which is more than a demo should ask for — and unlike the system
   * setting, a window override is reverted automatically when the app leaves the
   * foreground.
   */
  @JvmStatic
  fun getBrightness(): Double {
    val activity = activity() ?: return 0.0
    val override = activity.window.attributes.screenBrightness
    // BRIGHTNESS_OVERRIDE_NONE (-1) means this window has not set one, so what
    // the user actually sees is the system brightness.
    if (override >= 0f) return override.toDouble()
    return try {
      Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS) / 255.0
    } catch (e: Settings.SettingNotFoundException) {
      1.0
    }
  }

  @JvmStatic
  fun setBrightness(value: Double) {
    val activity = activity() ?: return
    val params = activity.window.attributes
    params.screenBrightness = value.coerceIn(0.0, 1.0).toFloat()
    // Legal without a post only because we are already on the main thread.
    activity.window.attributes = params
  }

  @JvmStatic
  fun vibrate() {
    val context = context() ?: return
    val vibrator =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val manager =
          context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        manager?.defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      } ?: return

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator.vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE))
    } else {
      @Suppress("DEPRECATION")
      vibrator.vibrate(40)
    }
  }

  @JvmStatic
  fun viewExists(tag: Int): Boolean = lookup(tag) != null

  /**
   * Sets the view's transform directly, bypassing Fabric — the Android mirror of
   * the iOS `CGAffineTransform` path. Note the unit change: JS thinks in RN's
   * density-independent points (as iOS does natively), but `View.translationX`
   * is in physical pixels, so translations are scaled by the display density.
   * Rotation crosses as radians and Android wants degrees.
   */
  @JvmStatic
  fun setViewTransform(
    tag: Int,
    translateX: Double,
    translateY: Double,
    scaleX: Double,
    scaleY: Double,
    rotateRadians: Double,
  ) {
    val view = lookup(tag) ?: return
    val density = view.resources.displayMetrics.density
    view.translationX = (translateX * density).toFloat()
    view.translationY = (translateY * density).toFloat()
    view.scaleX = scaleX.toFloat()
    view.scaleY = scaleY.toFloat()
    view.rotation = Math.toDegrees(rotateRadians).toFloat()
  }

  @JvmStatic
  fun setViewOpacity(tag: Int, opacity: Double) {
    lookup(tag)?.alpha = opacity.toFloat()
  }

  /**
   * Resolves a React tag to a platform view. Fabric's SurfaceMountingManager
   * assigns the React tag as the Android view id when it creates a component
   * view, so `findViewById` finds it — the same trick as `-viewWithTag:` on iOS,
   * and it needs no UIManager access.
   */
  private fun lookup(tag: Int): View? {
    val cached = cachedView?.get()
    if (cached != null && cachedTag == tag && cached.isAttachedToWindow) {
      return cached
    }
    val root = activity()?.window?.decorView ?: return null
    val found = root.findViewById<View>(tag)
    cachedView = if (found != null) WeakReference(found) else null
    cachedTag = tag
    return found
  }
}
