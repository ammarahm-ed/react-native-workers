import type { ReactNode } from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';

type DeviceFrameProps = {
  /** Screenshot under `static/img/…`, e.g. `/img/screens/tests.webp`. */
  src?: string;
  /** Screen recording under `static/img/…` (mp4). Autoplays, loops, muted. */
  video?: string;
  /** Required — describes what the capture shows. */
  alt: string;
  /** Explains what the reader is looking at. Rendered under the frame. */
  caption?: ReactNode;
  /** Rendered frame width in px (the screen inside is a little narrower). */
  width?: number;
  className?: string;
};

/**
 * A phone-screen frame around a real capture from the example app.
 *
 * The frame is CSS, not baked into the image: one asset serves both color
 * modes, stays sharp on retina, and restyling never means re-exporting a dozen
 * screenshots. The bezel is deliberately dark in both themes — that is what a
 * device looks like — with a cyan hairline in dark mode so it separates from
 * the page instead of dissolving into it.
 */
export default function DeviceFrame({
  src,
  video,
  alt,
  caption,
  width = 300,
  className,
}: DeviceFrameProps): ReactNode {
  const srcUrl = useBaseUrl(src ?? '');
  const videoUrl = useBaseUrl(video ?? '');
  return (
    <figure className={clsx(styles.figure, className)} style={{ width }}>
      <div className={styles.bezel}>
        <div className={styles.screen}>
          {video ? (
            <video
              className={styles.media}
              src={videoUrl}
              aria-label={alt}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
            />
          ) : (
            <img
              className={styles.media}
              src={srcUrl}
              alt={alt}
              loading="lazy"
            />
          )}
        </div>
      </div>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
    </figure>
  );
}

/** Lays several frames out in a row that wraps on narrow screens. */
export function Showcase({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.showcase}>{children}</div>;
}
