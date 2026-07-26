import { Fragment, type CSSProperties, type ReactNode } from 'react';
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

// The hero background: a "runtime system". The glowing core is the app's MAIN JS
// runtime (UI thread); each orbiting satellite is a worker runtime on its own
// thread; the packets sliding along each rotating spoke are `postMessage` traffic
// (outbound + a reply). Concentric orbits at different radii/speeds = independent
// workers. Pure CSS/HTML — only transform + opacity animate. See index.module.css.
const ORBITS: { r: number; dur: number; pdur: number }[] = [
  { r: 92, dur: 15, pdur: 2.0 },
  { r: 152, dur: 23, pdur: 2.8 },
  { r: 220, dur: 32, pdur: 3.6 },
  { r: 300, dur: 43, pdur: 4.6 },
];

function RuntimeSystem(): ReactNode {
  return (
    <div className={styles.system} aria-hidden="true">
      <div className={styles.stage}>
        {/* Main JS runtime (the "sun"). */}
        <span className={styles.core} />
        <span className={clsx(styles.corePulse, styles.corePulse2)} />
        <span className={styles.corePulse} />
        <span className={clsx(styles.corePulse, styles.corePulse3)} />

        {/* Worker runtimes orbiting the main runtime. */}
        {ORBITS.map((o, i) => {
          const reverse = i % 2 === 1;
          const orbitVars = {
            '--r': `${o.r}px`,
            '--dur': `${o.dur}s`,
            '--pdur': `${o.pdur}s`,
          } as CSSProperties;
          return (
            <Fragment key={i}>
              <span
                className={styles.orbitPath}
                style={{ '--r': `${o.r}px` } as CSSProperties}
              />
              <span
                className={clsx(styles.arm, reverse && styles.armReverse)}
                style={orbitVars}
              >
                <span className={styles.spoke} />
                <span className={styles.packet} />
                <span
                  className={clsx(styles.packet, styles.packetIn)}
                  style={{ '--pdelay': `${o.pdur * 0.5}s` } as CSSProperties}
                />
                <span className={styles.worker} />
              </span>
            </Fragment>
          );
        })}
      </div>
      {/* Calms the animation behind the centred hero copy so the logo, title and
          buttons stay crisp; the sun's glow + outer orbits still frame the edges. */}
      <div className={styles.scrim} />
    </div>
  );
}

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <RuntimeSystem />
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
