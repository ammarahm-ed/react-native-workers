package expo.modules.rnwprobe

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android counterpart of RNWProbeModule.swift — the same surface used to exercise
// Expo functions / properties / events from inside a worker runtime:
//   * Constant        — snapshot value
//   * Function (sync) / AsyncFunction
//   * Property        — a static one and a DYNAMIC one (changes every read)
//   * Events          — `onTick`, emitted on demand from `emitTick(count)`
class RNWProbeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RNWProbe")

    Constant("theConstant") {
      "const-value"
    }

    // Static property — same value every read.
    Property("answer") {
      42
    }

    // Dynamic property — changes over time, proving reads go live to the module
    // in the worker's own AppContext rather than being snapshotted once.
    Property("nowMs") {
      System.currentTimeMillis().toDouble()
    }

    Events("onTick")

    // Sync function that emits an event with a structured payload.
    Function("emitTick") { count: Int ->
      sendEvent(
        "onTick",
        mapOf(
          "count" to count,
          "label" to "tick",
        ),
      )
      "emitted:$count"
    }

    AsyncFunction("addAsync") { a: Double, b: Double ->
      a + b
    }
  }
}
