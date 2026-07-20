#pragma once

#include <ReactNativeWorkersSpecJSI.h>

#include <memory>

namespace facebook::react {

class ReactNativeWorkersImpl
  : public NativeReactNativeWorkersCxxSpec<ReactNativeWorkersImpl> {
public:
  ReactNativeWorkersImpl(std::shared_ptr<CallInvoker> jsInvoker);

  double multiply(jsi::Runtime& rt, double a, double b);
};

}
