import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { runBridgeTests } from './src/bridgeTests';
import { runConformance } from './src/conformance';
import { runDesktopTests } from './src/desktopTests';
import { runPrimitivesTests } from './src/primitivesTests';

type Line = { suite: string; name: string; pass: boolean; detail: string };

export default function App() {
  const [lines, setLines] = useState<Line[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Line[] = [];
      const run = async (
        suite: string,
        tests: () => Promise<{ name: string; pass: boolean; detail: unknown }[]>
      ) => {
        try {
          for (const test of await tests()) {
            out.push({
              suite,
              name: test.name,
              pass: test.pass,
              detail: String(test.detail),
            });
            if (!cancelled) setLines([...out]);
          }
        } catch (error) {
          out.push({
            suite,
            name: 'suite',
            pass: false,
            detail: String(error),
          });
          if (!cancelled) setLines([...out]);
        }
      };
      await run('conformance', runConformance);
      await run('primitives', runPrimitivesTests as never);
      await run('bridge', runBridgeTests as never);
      await run('desktop', runDesktopTests);
      if (!cancelled) setDone(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const failed = lines.filter((line) => !line.pass).length;
  return (
    <View style={styles.root}>
      <Text testID="summary" style={styles.title}>
        {!done ? 'RUNNING' : failed === 0 && lines.length > 0 ? 'PASS' : 'FAIL'}
      </Text>
      <Text
        testID="counts"
        style={styles.line}
      >{`${lines.length - failed} passed, ${failed} failed`}</Text>
      <ScrollView>
        {lines.map((line, index) => (
          <Text key={index} style={styles.line}>
            {`${line.pass ? 'ok' : 'FAIL'} - ${line.suite}: ${line.name}${line.pass ? '' : ` (${line.detail})`}`}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff', padding: 16, gap: 4 },
  title: { color: '#111111', fontSize: 18, fontWeight: '600' },
  line: { color: '#111111', fontSize: 12 },
});
