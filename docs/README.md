# react-native-workers documentation

The documentation site for [`@ammarahmed/react-native-workers`](../README.md),
built with [Docusaurus](https://docusaurus.io/).

## Develop

```bash
cd docs
npm install
npm run start   # local dev server with hot reload
```

## Build

```bash
npm run build   # static site into ./build
npm run serve   # preview the built site
```

## Structure

- `docs/` — the documentation pages (Markdown), organized into Guides,
  Shared data, and Calling across threads. The sidebar is generated from this
  folder (ordering via `sidebar_position` frontmatter and `_category_.json`).
- `src/pages/index.tsx` — the landing page.
- `docusaurus.config.ts` — site config.

The library's internal design/RFC docs live in [`../design-docs/`](../design-docs).
