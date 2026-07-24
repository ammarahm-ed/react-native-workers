#pragma once

#include <functional>
#include <memory>

namespace facebook::react::workers {

// Posts work onto the platform's main/UI thread. Implemented per-platform
// (iOS: dispatch_get_main_queue; Android: the main Looper) and registered once
// at startup via setMainThreadScheduler().
class MainThreadScheduler {
 public:
  virtual ~MainThreadScheduler() = default;
  virtual void post(std::function<void()> fn) = 0;
  virtual void postDelayed(std::function<void()> fn, double ms) = 0;
  virtual bool isOnMainThread() = 0;
};

// Registered by the platform layer (iOS registers eagerly at +load; Android
// registers a factory that is invoked lazily on first use — see below).
void setMainThreadScheduler(std::shared_ptr<MainThreadScheduler> scheduler);

// Registers a factory that builds the scheduler on first getMainThreadScheduler()
// call. Used on Android, where constructing the scheduler needs a JNI-attached
// thread (unavailable at library-load / static-init time). The factory runs once,
// on the thread of the first getMainThreadScheduler() call (the JS thread, when a
// UIWorker is created). Ignored once a scheduler has been set explicitly.
void setMainThreadSchedulerFactory(
    std::function<std::shared_ptr<MainThreadScheduler>()> factory);

// Returns the registered scheduler, constructing it from the factory on first
// call if one was registered. Null when no scheduler/factory exists for the
// platform (e.g. a platform that has not implemented UIWorker support).
std::shared_ptr<MainThreadScheduler> getMainThreadScheduler();

#if defined(__ANDROID__)
// Registers the Android main-thread scheduler factory (a Handler on the main
// Looper). Defined in MainThreadSchedulerAndroid.cpp and called at library load
// from an already-linked TU so that file — an otherwise-unreferenced object in
// this static archive — is retained by the linker.
void installAndroidMainThreadSchedulerFactory();
#endif

} // namespace facebook::react::workers
