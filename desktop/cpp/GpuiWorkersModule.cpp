// The desktop platform layer: the main-thread scheduler, the worker bundle
// reader and the TurboModule provider react-native-gpui's autolinking calls.

#include "ReactNativeWorkersImpl.h"
#include "runtime/MainThreadScheduler.h"
#include "runtime/WorkerAssetReader.h"

#include "GpuiTurboModule.h"
#include "rn-gpui-sys/src/lib.rs.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <thread>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#elif defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace {
namespace workers = facebook::react::workers;
namespace fs = std::filesystem;

class DesktopMainThreadScheduler final : public workers::MainThreadScheduler {
 public:
  void post(std::function<void()> fn) override {
    rngpui::dispatchMain(std::move(fn));
  }

  void postDelayed(std::function<void()> fn, double ms) override {
    std::thread([fn = std::move(fn), ms]() mutable {
      std::this_thread::sleep_for(
          std::chrono::microseconds(static_cast<long long>(ms * 1000.0)));
      rngpui::dispatchMain(std::move(fn));
    }).detach();
  }

  bool isOnMainThread() override {
    return rngpui::rn_gpui_is_main_thread();
  }
};

fs::path executablePath() {
#if defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string buffer(size, '\0');
  if (_NSGetExecutablePath(buffer.data(), &size) != 0) {
    return {};
  }
  return fs::weakly_canonical(fs::path(buffer.c_str()));
#elif defined(_WIN32)
  wchar_t buffer[MAX_PATH];
  const auto length = GetModuleFileNameW(nullptr, buffer, MAX_PATH);
  return length == 0 ? fs::path() : fs::path(std::wstring(buffer, length));
#else
  std::error_code error;
  return fs::read_symlink("/proc/self/exe", error);
#endif
}

// Where the worker bundles are. A development run names the app's bundle in
// RN_GPUI_BUNDLE and the worker bundles sit beside it; a packaged app finds
// them in the resource directory its executable implies, the same one the app
// bundle is read from.
fs::path resourceDirectory() {
  if (const char* bundle = std::getenv("RN_GPUI_BUNDLE")) {
    if (*bundle != '\0') {
      return fs::path(bundle).parent_path();
    }
  }
  const fs::path executable = executablePath();
  if (executable.empty()) {
    return {};
  }
  const fs::path directory = executable.parent_path();
#if defined(__APPLE__)
  return directory.parent_path() / "Resources";
#elif defined(_WIN32)
  return directory;
#else
  return directory.parent_path() / "lib" / executable.stem();
#endif
}

class DesktopWorkerAssetReader final : public workers::WorkerAssetReader {
 public:
  bool read(
      const std::string& assetName,
      std::string& out,
      std::string& error) override {
    const fs::path root = resourceDirectory();
    if (root.empty()) {
      error = "could not find the application's resource directory";
      return false;
    }
    const fs::path path = root / assetName;
    std::ifstream file(path, std::ios::binary);
    if (!file) {
      error = "no worker bundle at " + path.string() +
          " (run rn-workers-bundle --platform desktop and ship the output as a resource)";
      return false;
    }
    std::ostringstream contents;
    contents << file.rdbuf();
    out = contents.str();
    return true;
  }
};

void installPlatform() {
  static std::once_flag once;
  std::call_once(once, [] {
    workers::setMainThreadScheduler(
        std::make_shared<DesktopMainThreadScheduler>());
    workers::setWorkerAssetReader(std::make_shared<DesktopWorkerAssetReader>());
  });
}
} // namespace

std::shared_ptr<facebook::react::TurboModule> create_gpui_workers_module(
    const std::string& name,
    std::shared_ptr<facebook::react::CallInvoker> jsInvoker) {
  if (name != facebook::react::ReactNativeWorkersImpl::kModuleName) {
    return nullptr;
  }
  installPlatform();
  return rngpui::provideTurboModule<facebook::react::ReactNativeWorkersImpl>(
      name, std::move(jsInvoker));
}
