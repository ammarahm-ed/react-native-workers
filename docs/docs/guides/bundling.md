---
sidebar_position: 6
title: Bundling file workers
---

# Bundling file workers

Inline workers need no build setup. **File workers** (`new Worker('./task')`) do —
each worker is a separate program that must be compiled into its own bundle. This
page explains the Babel plugin and how loading differs in dev vs release.

## The Babel plugin

Add it to your app's Babel config:

```js title="babel.config.js"
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [require.resolve('@ammarahmed/react-native-workers/plugin')],
};
```

The plugin scans for `new Worker('./relative/path')` calls with a **string
literal** relative path, and:

1. records each referenced worker file in a manifest;
2. rewrites the call so the runtime knows how to load that worker's bundle.

```js
// you write:
const w = new Worker('./workers/heavy');

// the plugin rewrites it to a descriptor the runtime resolves at load time.
```

Only relative string literals are rewritten. `new Worker({ inline })` and
`new Worker(someVariable)` are left alone.

## Development

In dev, the runtime loads a worker by **fetching its bundle from Metro** over HTTP
and running it inline. This means:

- fast refresh of worker code works like the rest of your app;
- no extra build step during development.

Just run your app normally (`react-native start` + run the app).

## Release builds

For release, there's no Metro server, so each worker bundle must be **built ahead
of time** and shipped with the app. Wire the bundling step into your native build:

- **Android** — apply the Gradle script:

  ```groovy title="android/app/build.gradle"
  apply from: "../../node_modules/@ammarahmed/react-native-workers/android/worker-bundles.gradle"
  ```

- **iOS** — add the bundling shell script as an Xcode build phase (see
  `scripts/ios-bundle-workers.sh` in the package).

The CLI that produces the per-worker bundles is also runnable directly:

```bash
npx react-native-workers bundle
```

:::info[Status]
The release CLI + Gradle/Xcode wiring produce the per-worker bundles today. Loading
release `.jsbundle` files needs a native asset reader (iOS `NSBundle` / Android
`AssetManager`) — that companion piece is the remaining work; **inline workers and
dev file-workers work fully now**. See the repository's `IMPLEMENTATION.md` for the
current status.
:::

## Tips

- Keep worker files small and dependency-light — every import is bundled into the
  worker, not shared with your app bundle.
- Prefer **inline** workers for tiny one-off tasks and **file** workers for
  anything you'd want to unit-test or reuse.
