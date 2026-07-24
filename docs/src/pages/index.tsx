import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Logo from '@site/src/components/Logo';
import Heading from '@theme/Heading';

import styles from './index.module.css';

const SNIPPET = `import { Worker } from '@ammarahmed/react-native-workers';

// Load worker code from its own file — it runs on another
// thread, in its own JS runtime. (Small snippets can also be
// passed inline: new Worker({ inline: '…code…' }).)
const worker = new Worker('./workers/double');

worker.onmessage = (e) => console.log(e.data); // 42
worker.postMessage(21);`;

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
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
      </main>
    </Layout>
  );
}
