import type { ReactNode } from 'react';
import clsx from 'clsx';
import useBaseUrl from '@docusaurus/useBaseUrl';

import styles from './styles.module.css';

type LogoProps = {
  /** Rendered size in px (the logo is square). */
  size?: number;
  /** Cyan glow behind the mark — used on the dark homepage hero. */
  glow?: boolean;
  className?: string;
};

/**
 * The library logo. The gear rotation is defined inside logo.svg itself so the
 * same file animates both here and as the navbar logo (which Docusaurus renders
 * as an <img>, out of reach of page CSS).
 */
export default function Logo({
  size = 96,
  glow = false,
  className,
}: LogoProps): ReactNode {
  return (
    <img
      src={useBaseUrl('/img/logo.svg')}
      alt="react-native-workers"
      width={size}
      height={size}
      className={clsx(styles.logo, glow && styles.glow, className)}
    />
  );
}
