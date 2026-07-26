import { type CSSProperties, type ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Logo from '@site/src/components/Logo';
import DeviceFrame, { Showcase } from '@site/src/components/DeviceFrame';
import Heading from '@theme/Heading';

import styles from './index.module.css';

const SNIPPET = `import { Worker } from '@ammarahmed/react-native-workers';

// Load worker code from its own file — it runs on another
// thread, in its own JS runtime. (Small snippets can also be
// passed inline: new Worker({ inline: '…code…' }).)
const worker = new Worker('./workers/double');

worker.onmessage = (e) => console.log(e.data); // 42
worker.postMessage(21);`;

// The hero background: a field of parallel threads. Each lane is an OS thread and
// the pulse travelling down it is work in flight — many lanes running at their own
// speeds, at the same time, which is the whole pitch. Same treatment as the launch
// cards. Pure CSS/HTML — only `transform` animates. See index.module.css.
const LANES = 16;

function ThreadField(): ReactNode {
  return (
    <div className={styles.field} aria-hidden="true">
      {Array.from({ length: LANES }, (_, i) => (
        <span
          key={i}
          className={styles.lane}
          style={
            {
              '--top': `${((i + 0.5) * 100) / LANES}%`,
              // Coprime-ish spread so the lanes never fall into lockstep.
              '--dur': `${(4.2 + (i % 5) * 1.3).toFixed(2)}s`,
              '--delay': `${(-((i * 0.83) % 6)).toFixed(2)}s`,
            } as CSSProperties
          }
        />
      ))}
      <span className={styles.grid} />
      <span className={styles.glow} />
      {/* Calms the animation behind the centred hero copy so the logo, title and
          buttons stay crisp; the lanes still run at the edges. */}
      <div className={styles.scrim} />
    </div>
  );
}

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <ThreadField />
      <div className="container">
        <Logo size={112} glow className={styles.heroLogo} />
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/intro"
          >
            Get started
          </Link>
          <Link
            className="button button--outline button--secondary button--lg"
            style={{ marginLeft: 12 }}
            to="/docs/quick-start"
          >
            Quick start
          </Link>
        </div>
        <div className={styles.heroCode}>
          <CodeBlock language="js">{SNIPPET}</CodeBlock>
        </div>
      </div>
    </header>
  );
}

/** Real captures from the example app, so the claims above have a face. */
function HomepageShowcase(): ReactNode {
  return (
    <section className={styles.showcaseSection}>
      <div className="container">
        <Heading as="h2" className={styles.showcaseHeading}>
          Running on a device
        </Heading>
        <p className={styles.showcaseLede}>
          Captures from the{' '}
          <Link to="https://github.com/ammarahm-ed/react-native-workers/tree/main/example">
            example app
          </Link>{' '}
          — one screen per feature, all of it runnable.
        </p>
        <Showcase>
          <DeviceFrame
            width={236}
            video="/img/video/uiworker-animate.mp4"
            alt="A square view rotating at 60fps driven from a UIWorker, still animating while the app's JS thread is blocked for two seconds"
            caption={
              <>
                A <code>UIWorker</code> animating a real view at 60&nbsp;fps —
                while the app's JS thread is blocked.
              </>
            }
          />
          <DeviceFrame
            width={236}
            src="/img/screens/parse.webp"
            alt="Parallel parse results: 120,000 log lines parsed by 1, 2, 4 and 8 workers in 54ms, 29ms, 18ms and 17ms — a 3.18x speedup"
            caption={
              <>
                2.58&nbsp;MB of logs across 8 nested workers over one shared
                buffer — 3.18× faster.
              </>
            }
          />
          <DeviceFrame
            width={236}
            src="/img/screens/nativecomponent.webp"
            alt="A live MKMapView with custom pins, rendered by a view manager written in JavaScript and registered from a UIWorker"
            caption={
              <>
                A live <code>MKMapView</code> host component, its view manager
                written in JavaScript.
              </>
            }
          />
        </Showcase>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Web Worker–style multithreading for React Native — separate Hermes runtimes on real threads, native modules, fast shared memory, and full DevTools debugging."
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
        <HomepageShowcase />
      </main>
    </Layout>
  );
}
