import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const GITHUB_URL = 'https://github.com/ammarahm-ed/react-native-workers';
const BASE_URL = '/react-native-workers/';

const config: Config = {
  title: 'react-native-workers',
  tagline: 'Web Worker–style multithreading for React Native',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://ammarahm-ed.github.io',
  baseUrl: BASE_URL,

  organizationName: 'ammarahm-ed',
  projectName: 'react-native-workers',

  onBrokenLinks: 'throw',

  // `favicon` above only emits the .ico link; the rest of the icon set is wired here.
  // headTags hrefs are emitted verbatim, so they must include the baseUrl.
  headTags: [
    {
      tagName: 'link',
      attributes: {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: `${BASE_URL}img/favicon-32x32.png`,
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: `${BASE_URL}img/favicon-16x16.png`,
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: `${BASE_URL}img/apple-touch-icon.png`,
      },
    },
    {
      tagName: 'link',
      attributes: {
        rel: 'manifest',
        href: `${BASE_URL}img/site.webmanifest`,
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'theme-color',
        content: '#06bcee',
      },
    },
  ],

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  themes: ['@docusaurus/theme-mermaid'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: `${GITHUB_URL}/tree/main/docs/`,
        },
        blog: {
          showReadingTime: true,
          blogTitle: 'Blog',
          blogDescription:
            'Release announcements and deep dives on react-native-workers.',
          blogSidebarTitle: 'All posts',
          blogSidebarCount: 'ALL',
          postsPerPage: 10,
          editUrl: `${GITHUB_URL}/tree/main/docs/`,
          feedOptions: {
            type: ['rss', 'atom'],
            title: 'react-native-workers blog',
            description:
              'Release announcements and deep dives on react-native-workers.',
            copyright: `Copyright © ${new Date().getFullYear()} react-native-workers.`,
          },
          // Keep builds resilient regardless of how a post declares authors/excerpts.
          onInlineAuthors: 'ignore',
          onUntruncatedBlogPosts: 'ignore',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/workers-social-card.png',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'react-native-workers',
      logo: {
        alt: 'react-native-workers',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/blog',
          label: 'Blog',
          position: 'left',
        },
        {
          href: 'https://www.npmjs.com/package/@ammarahmed/react-native-workers',
          label: 'npm',
          position: 'right',
        },
        {
          href: GITHUB_URL,
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Introduction', to: '/docs/intro' },
            { label: 'Installation', to: '/docs/installation' },
            { label: 'Quick start', to: '/docs/quick-start' },
          ],
        },
        {
          title: 'Guides',
          items: [
            { label: 'Shared data', to: '/docs/shared-data/overview' },
            { label: 'JSModule bridge', to: '/docs/rpc/jsmodule-bridge' },
            { label: 'defineModule', to: '/docs/rpc/define-module' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: GITHUB_URL },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/@ammarahmed/react-native-workers',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} react-native-workers. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: [
        'bash',
        'json',
        'diff',
        'kotlin',
        'objectivec',
        'cpp',
        'ruby',
        'groovy',
      ],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
