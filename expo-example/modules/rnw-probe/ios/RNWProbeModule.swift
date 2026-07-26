import ExpoModulesCore

// A tiny local Expo module that deliberately exercises the surfaces we bridge into
// a worker runtime:
//   * Constant        — snapshot value (already supported)
//   * Function (sync) / AsyncFunction — call paths (already supported)
//   * Property        — a static one and a DYNAMIC one (live getter over the bridge)
//   * Events          — `onTick`, emitted on demand from `emitTick(count)`
//
// The worker probe reads `answer`/`nowMs`, subscribes to `onTick`, then calls
// `emitTick` and expects the event to arrive back inside the worker.
public class RNWProbeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RNWProbe")

    Constant("theConstant") {
      "const-value"
    }

    // Static property — same value every read.
    Property("answer") {
      42
    }

    // Dynamic property — changes over time, proving reads go live to the main
    // runtime rather than being snapshotted once.
    Property("nowMs") {
      Date().timeIntervalSince1970 * 1000.0
    }

    Events("onTick")

    // Sync function that emits an event with a structured payload.
    Function("emitTick") { (count: Int) -> String in
      self.sendEvent("onTick", [
        "count": count,
        "label": "tick"
      ])
      return "emitted:\(count)"
    }

    AsyncFunction("addAsync") { (a: Double, b: Double) -> Double in
      return a + b
    }
  }
}
