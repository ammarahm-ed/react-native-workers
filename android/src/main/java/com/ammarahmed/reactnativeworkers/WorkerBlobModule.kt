package com.ammarahmed.reactnativeworkers

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.modules.blob.BlobModule

/**
 * Drop-in `BlobModule` for worker runtimes, so `Blob` (and everything built on it
 * — `URL.createObjectURL`, blob-backed `fetch`/XHR, WebSocket sends) works inside
 * a worker instead of throwing "BlobModule is not available".
 *
 * ### Why RN's own BlobModule cannot be used
 * Its `initialize()` calls `BlobCollector.install(reactApplicationContext, this)`,
 * which resolves the JS context from the *host* ReactApplicationContext — so a
 * worker's BlobModule installs a `__blobCollectorProvider` onto the **host**
 * runtime, capturing a `jni::global_ref`. Each worker overwrites and orphans the
 * previous provider, and the host's Hermes GC thread later releases that ref while
 * unattached to the JVM, aborting the process in `DeleteGlobalRef`.
 *
 * ### Why this is a *legacy* module, not a TurboModule
 * RN's generated JSI spec dispatches through a **process-wide** cache:
 * ```cpp
 * static jmethodID cachedMethodId = nullptr;   // FBReactNativeSpec-generated.cpp
 * ```
 * The host's real `BlobModule` populates that static first, so invoking the same
 * method on an instance of any *other* class aborts with
 * "can't call BlobModule.createFromParts on instance of WorkerBlobModule". RN's
 * TurboModule dispatch therefore assumes exactly one Java class per module name
 * per process, and a TurboModule shim is impossible. The legacy interop path
 * (`JavaInteropTurboModule`) instead reflects over the actual instance, so it
 * dispatches correctly — hence a plain `@ReactMethod` module here, and
 * `isTurboModule = false` in [WorkerBlobPackage].
 *
 * All blob storage is delegated to the host's live [BlobModule], so blobs created
 * in a worker resolve on the host and vice versa. The collector itself is
 * installed per-worker from C++ (cpp/bindings/WorkerBlobCollector.cpp) and holds
 * no JNI reference at all — only the blob id — so it is safe to finalize on
 * Hermes's GC thread.
 *
 * Requires RN's `useTurboModuleInterop` feature flag (on by default with
 * bridgeless). With it disabled, workers simply have no BlobModule, exactly as
 * before this shim existed.
 */
@ReactModule(name = WorkerBlobModule.NAME)
internal class WorkerBlobModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  override fun getConstants(): Map<String, Any> {
    // Mirrors BlobModule.getTypedExportedConstants.
    val resources = reactApplicationContext.resources
    val packageName = reactApplicationContext.packageName
    val resourceId =
      resources.getIdentifier("blob_provider_authority", "string", packageName)
    if (resourceId == 0) {
      return emptyMap()
    }
    return mapOf(
      "BLOB_URI_SCHEME" to "content",
      "BLOB_URI_HOST" to resources.getString(resourceId),
    )
  }

  private val host: BlobModule?
    get() = hostModule(reactApplicationContext)

  @ReactMethod
  fun addNetworkingHandler() {
    host?.addNetworkingHandler()
  }

  @ReactMethod
  fun addWebSocketHandler(id: Double) {
    host?.addWebSocketHandler(id)
  }

  @ReactMethod
  fun removeWebSocketHandler(id: Double) {
    host?.removeWebSocketHandler(id)
  }

  @ReactMethod
  fun sendOverSocket(blob: ReadableMap, socketID: Double) {
    host?.sendOverSocket(blob, socketID)
  }

  @ReactMethod
  fun createFromParts(parts: ReadableArray, withId: String) {
    host?.createFromParts(parts, withId)
  }

  @ReactMethod
  fun release(blobId: String) {
    host?.release(blobId)
  }

  internal companion object {
    const val NAME: String = "BlobModule"

    @Volatile private var cached: BlobModule? = null

    /** The host app's live BlobModule — the single owner of all blob data. */
    @JvmStatic
    fun hostModule(context: ReactApplicationContext): BlobModule? {
      cached?.let { return it }
      return try {
        context.getNativeModule(BlobModule::class.java)?.also { cached = it }
      } catch (t: Throwable) {
        android.util.Log.w("RNWorkerTM", "host BlobModule unavailable to workers: $t")
        null
      }
    }

    /**
     * Called from the worker's blob collector when a JS `Blob` is garbage
     * collected. Static and reference-free by design: the C++ collector captures
     * only a `std::string`, never a `jni::global_ref`, which is precisely what
     * makes it safe to finalize on Hermes's GC thread.
     */
    @JvmStatic
    fun releaseBlob(blobId: String) {
      try {
        cached?.remove(blobId)
      } catch (t: Throwable) {
        android.util.Log.w("RNWorkerTM", "releaseBlob($blobId) failed: $t")
      }
    }
  }
}

/** Supplies [WorkerBlobModule] to worker runtimes under the name `BlobModule`. */
internal class WorkerBlobPackage : BaseReactPackage() {
  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? =
    if (name == WorkerBlobModule.NAME) WorkerBlobModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
    ReactModuleInfoProvider {
      mapOf(
        WorkerBlobModule.NAME to
          ReactModuleInfo(
            WorkerBlobModule.NAME,
            WorkerBlobModule::class.java.name,
            /* canOverrideExistingModule = */ true,
            /* needsEagerInit = */ false,
            /* isCxxModule = */ false,
            // Deliberately NOT a TurboModule — see the class docs: RN's generated
            // JSI dispatch caches jmethodIDs process-wide, so only the legacy
            // interop path can serve a second class under an existing name.
            /* isTurboModule = */ false,
          )
      )
    }
}
