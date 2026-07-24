import type { ComponentType } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** A component descriptor the worker reports (see the worker's `list()`). */
export type Descriptor = { name: string; props: string[]; events: string[] };

/**
 * Web variant of the worker-defined native component adapter.
 *
 * Worker-defined native components are backed by a runtime-registered native view
 * manager — a native-only mechanism with no equivalent on the web. The native file
 * ([createWorkerComponent.tsx](./createWorkerComponent.tsx)) deep-imports
 * `NativeComponentRegistry`, which does not exist in react-native-web, so this
 * `.web` sibling stands in for the web bundle and renders a visible placeholder
 * instead of the native view.
 */
export function createWorkerComponent(
  descriptor: Descriptor
): ComponentType<any> {
  return function WorkerComponentUnavailable() {
    return (
      <View style={styles.placeholder}>
        <Text>{`"${descriptor.name}" is a native-only worker component`}</Text>
      </View>
    );
  };
}

const styles = StyleSheet.create({
  placeholder: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
  },
});
