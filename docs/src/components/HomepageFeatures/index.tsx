import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  emoji: string;
  to: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Real threads, real JS',
    emoji: '🧵',
    to: '/docs/guides/creating-workers',
    description: (
      <>
        Each worker is a separate Hermes runtime on its own OS thread — with{' '}
        <code>postMessage</code>/<code>onmessage</code>, structured clone,
        timers, and promises. Move heavy work off the JS thread.
      </>
    ),
  },
  {
    title: 'Native modules in workers',
    emoji: '🔌',
    to: '/docs/guides/native-modules',
    description: (
      <>
        Call C++ and platform (Java/ObjC) TurboModules from a worker, subscribe
        to <code>NativeEventEmitter</code> events, and spawn nested workers.
      </>
    ),
  },
  {
    title: 'Fast shared data',
    emoji: '⚡',
    to: '/docs/shared-data/overview',
    description: (
      <>
        A whole ladder — <code>SharedStore</code> (granular, watchable state),{' '}
        <code>SharedValue</code> (lock-free cells), and{' '}
        <code>SharedBuffer</code> (zero-copy shared memory for bulk math).
      </>
    ),
  },
  {
    title: 'Typed two-way RPC',
    emoji: '🔁',
    to: '/docs/rpc/define-module',
    description: (
      <>
        With <code>defineModule</code>, host and worker call each other's
        functions like local <code>async</code> functions — fully typed from one
        contract.
      </>
    ),
  },
  {
    title: 'Granular & efficient',
    emoji: '🎯',
    to: '/docs/shared-data/shared-store',
    description: (
      <>
        Read and patch <em>parts</em> of shared state (<code>getIn</code>/
        <code>setIn</code>) — updating one field is ~4× cheaper than resending
        the whole object.
      </>
    ),
  },
  {
    title: 'UI-thread workers',
    emoji: '🖼️',
    to: '/docs/guides/ui-worker',
    description: (
      <>
        A <code>UIWorker</code> runs its JS on the platform main thread for
        UI-affine work — pair it with shared values for worklet-style speed.
      </>
    ),
  },
  {
    title: 'Debuggable',
    emoji: '🐛',
    to: '/docs/guides/debugging',
    description: (
      <>
        Every worker is its own Hermes DevTools target — set breakpoints, step
        through worker code, and read its sources. <code>console</code> output
        is forwarded to the host, tagged with the worker's name.
      </>
    ),
  },
  {
    title: 'Fast, small bundles',
    emoji: '🚀',
    to: '/docs/guides/bundling',
    description: (
      <>
        Release worker bundles are precompiled to Hermes bytecode (HBC) — no
        parse step, so workers start fast — and ship ~150&nbsp;KB each, because
        the UI half of React Native never enters the graph.
      </>
    ),
  },
];

function Feature({ title, emoji, description, to }: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <Link to={to} className={styles.featureCard}>
        <div className={styles.featureEmoji}>{emoji}</div>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </Link>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
