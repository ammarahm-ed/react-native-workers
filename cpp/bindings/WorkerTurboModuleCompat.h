#pragma once

// React Native changed the `TurboModuleBinding::install` provider signature: RN
// 0.85 added a runtime-aware overload (TurboModuleProviderFunctionTypeWithRuntime,
// taking `(jsi::Runtime&, const std::string&)`) and deprecated the original
// name-only form. RN 0.81–0.84 (e.g. what Expo SDK 54 ships) has ONLY the
// name-only overload, so a 2-arg provider lambda fails to compile there.
//
// None of this library's worker providers actually use the runtime, so we route
// every install site through one helper that picks the right arity per RN version.
// The name-only overload is present across the whole supported range (0.81.4–0.86),
// so it is the safe fallback when the version can't be determined.

#include <ReactCommon/TurboModule.h>
#include <ReactCommon/TurboModuleBinding.h>
#include <jsi/jsi.h>

#include <functional>
#include <memory>
#include <string>
#include <utility>

#if __has_include(<cxxreact/ReactNativeVersion.h>)
#include <cxxreact/ReactNativeVersion.h>
#endif

namespace facebook::react::workers {

// Resolves a TurboModule by name (the runtime is never needed by worker providers).
using WorkerModuleResolver =
    std::function<std::shared_ptr<TurboModule>(const std::string&)>;

inline void installWorkerTurboModuleBinding(
    jsi::Runtime& rt,
    WorkerModuleResolver resolver) {
#if defined(REACT_NATIVE_VERSION_MINOR) && \
    (REACT_NATIVE_VERSION_MAJOR > 0 || REACT_NATIVE_VERSION_MINOR >= 85)
  // RN 0.85+: runtime-aware provider (the name-only overload is deprecated here).
  TurboModuleBinding::install(
      rt,
      [resolver = std::move(resolver)](
          jsi::Runtime&, const std::string& name) { return resolver(name); });
#else
  // RN 0.81–0.84 (incl. Expo SDK 54 / RN 0.81): name-only provider.
  TurboModuleBinding::install(
      rt, [resolver = std::move(resolver)](const std::string& name) {
        return resolver(name);
      });
#endif
}

} // namespace facebook::react::workers
