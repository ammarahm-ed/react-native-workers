#include "ReactNativeWorkersImpl.h"

namespace facebook::react {

ReactNativeWorkersImpl::ReactNativeWorkersImpl(
  std::shared_ptr<CallInvoker> jsInvoker
)
  : NativeReactNativeWorkersCxxSpec(std::move(jsInvoker)) {}

double ReactNativeWorkersImpl::multiply(
  jsi::Runtime& rt,
  double a,
  double b
) {
  return a * b;
}

}
