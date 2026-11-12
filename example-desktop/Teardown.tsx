import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Worker } from '@ammarahmed/react-native-workers';

const CYCLES = 200;
const CODE = `
  const data = new Array(200000).fill(1);
  self.onmessage = (e) => self.postMessage({ n: e.data, sum: data.length });
`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cycle(index: number) {
  const worker = new Worker({ inline: CODE });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply ' + index)), 10000);
    worker.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.postMessage(index);
  });
  worker.terminate();
}

/** Creates and terminates workers in rounds, telling a harness which phase it is in. */
export default function Teardown() {
  const [phase, setPhase] = useState('start');

  useEffect(() => {
    (async () => {
      const gc = () => (globalThis as any).__rnworkersCollectGarbage?.();
      setPhase('baseline');
      await wait(3000);
      for (let round = 1; round <= 2; round++) {
        setPhase('running-' + round);
        for (let i = 0; i < CYCLES; i++) {
          await cycle(i);
          if (i % 20 === 19) await wait(5);
        }
        setPhase('settling-' + round);
        gc();
        await wait(500);
        gc();
        await wait(4000);
        setPhase('settled-' + round);
        await wait(4000);
      }
      setPhase('done');
      await wait(60000);
    })().catch((error) => setPhase('FAILED ' + String(error)));
  }, []);

  return (
    <View style={styles.root}>
      <Text testID="phase" style={styles.text}>{`phase:${phase}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff', padding: 16 },
  text: { color: '#111111', fontSize: 14 },
});
