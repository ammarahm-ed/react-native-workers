#pragma once

#include <functional>
#include <memory>
#include <string>

namespace facebook::react::workers {

// Reads a pre-built worker bundle shipped inside the app.
//
// In release there is no Metro to fetch from, so `new Worker('./x')` resolves to
// an asset name (`workers/<sanitized-id>.jsbundle`, produced by the release CLI
// and matched by `workerAssetName()` in src/resolveWorkerSource.ts). This
// interface is how the C++ core gets those bytes; each platform implements it
// (iOS: NSBundle, Android: AssetManager).
//
// The bytes may be plain JS **or Hermes bytecode** — the CLI compiles bundles
// with hermesc when it can, keeping the same `.jsbundle` name. Nothing here has
// to care: Hermes detects the bytecode magic in evaluateJavaScript and takes the
// HBC path automatically. That is also why `read()` deals in bytes rather than a
// source string, and why callers must not assume the content is text or
// NUL-terminated.
class WorkerAssetReader {
 public:
  virtual ~WorkerAssetReader() = default;

  // Reads `assetName` (e.g. "workers/src_workers_fib.jsbundle") into `out`.
  // Returns false and fills `error` with a human-readable reason on failure —
  // a missing worker bundle is a build-configuration mistake, and the message
  // is surfaced to the parent's onerror.
  virtual bool read(
      const std::string& assetName,
      std::string& out,
      std::string& error) = 0;
};

// Registered once by the platform layer. iOS registers eagerly at +load;
// Android registers a factory (below) because the reader needs a JNI-attached
// thread and the app's AssetManager, neither available at static-init time.
void setWorkerAssetReader(std::shared_ptr<WorkerAssetReader> reader);

// Registers a factory invoked on the first getWorkerAssetReader() call.
// Ignored once a reader has been set explicitly.
void setWorkerAssetReaderFactory(
    std::function<std::shared_ptr<WorkerAssetReader>()> factory);

// Returns the registered reader, building it from the factory on first use.
// Null when the platform has no reader registered, in which case bundled
// workers are unavailable and the caller reports that.
std::shared_ptr<WorkerAssetReader> getWorkerAssetReader();

#if defined(__ANDROID__)
// See installAndroidMainThreadSchedulerFactory() for why this exists: the
// Android TU is otherwise unreferenced in this static archive and would be
// dropped by the linker.
void installAndroidWorkerAssetReaderFactory();
#endif

} // namespace facebook::react::workers
