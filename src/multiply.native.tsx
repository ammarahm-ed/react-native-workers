import ReactNativeWorkers from './NativeReactNativeWorkers';

export function multiply(a: number, b: number): number {
  return ReactNativeWorkers.multiply(a, b);
}
