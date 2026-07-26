#include "WorkerExpoModules.h"

#include <cstdio>
#include <mutex>
#include <utility>

#if defined(__ANDROID__)
#include <android/log.h>
#define RNWEXPO_LOG(...) \
  __android_log_print(ANDROID_LOG_INFO, "RNWorkerExpo", __VA_ARGS__)
#else
#define RNWEXPO_LOG(...)               \
  do {                                 \
    fprintf(stderr, "[RNWorkerExpo] "); \
    fprintf(stderr, __VA_ARGS__);      \
    fprintf(stderr, "\n");             \
  } while (0)
#endif

namespace facebook::react::workers {

namespace {
std::mutex& mutex() {
  static std::mutex m;
  return m;
}
ExpoModulesInstaller& slot() {
  static ExpoModulesInstaller installer;
  return installer;
}
} // namespace

void setExpoModulesInstaller(ExpoModulesInstaller installer) {
  std::lock_guard<std::mutex> lock(mutex());
  slot() = std::move(installer);
  RNWEXPO_LOG("installer registered (ExpoModulesCore IS linked into this pod)");
}

std::function<void()> installExpoModulesInWorker(
    jsi::Runtime& rt,
    std::shared_ptr<CallInvoker> invoker) {
  ExpoModulesInstaller installer;
  {
    std::lock_guard<std::mutex> lock(mutex());
    installer = slot();
  }
  if (!installer) {
    // The platform installer is only present when ExpoModulesCore is linked
    // (iOS: the .mm is compiled when the headers are visible; Android: the
    // WorkerExpoModulesAndroid installer always registers but no-ops when the
    // app has no Expo). If you see this in an Expo app on iOS, the podspec is not
    // exposing ExpoModulesCore to ReactNativeWorkers.
    RNWEXPO_LOG(
        "no installer registered — ExpoModulesCore not linked into this build; "
        "global.expo will be absent in the worker");
    return {};
  }
  try {
    std::function<void()> teardown = installer(rt, std::move(invoker));
    RNWEXPO_LOG("installer ran (teardown=%s)", teardown ? "yes" : "none");
    return teardown;
  } catch (const std::exception& e) {
    RNWEXPO_LOG("installer threw: %s", e.what());
    return {};
  } catch (...) {
    // Never let an Expo-install failure take down the worker; the worker just
    // runs without `global.expo`.
    RNWEXPO_LOG("installer threw (non-std)");
    return {};
  }
}

} // namespace facebook::react::workers
