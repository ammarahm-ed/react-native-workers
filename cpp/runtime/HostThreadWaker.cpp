#include "HostThreadWaker.h"

namespace facebook::react::workers {

#if !defined(__ANDROID__)

// No non-Android implementation. On iOS the host hop is an RCTMessageThread post
// onto a CFRunLoop source — it stays in C/ObjC with no VM boundary to avoid, so
// there is nothing here worth bypassing. Callers use the CallInvoker.
std::shared_ptr<HostThreadWaker> createHostThreadWaker(jsi::Runtime&) {
  return nullptr;
}

#endif

} // namespace facebook::react::workers
