#!/usr/bin/env node
/**
 * Regenerates NativeScript interop metadata for this app, INCLUDING React
 * Native's own Obj-C classes.
 *
 * `@nativescript/react-native` bundles metadata generated from the bare iOS SDK
 * — 5243 classes, none of them `RCT*` — and the `nativescript-rn-generate-metadata`
 * CLI it ships is a stub that prints its config and writes nothing. The real
 * generator lives in the NativeScript/napi-ios repo, so this script drives that
 * binary directly against this app's CocoaPods headers.
 *
 * Run it with:
 *
 *     node scripts/generate-nativescript-metadata.mjs
 *
 * The generator binary is checked in at `scripts/bin/objc-metadata-generator`
 * (arm64), so nothing has to be compiled. It links `@rpath/libclang.dylib`
 * against Xcode's own toolchain — no LLVM download, but it does need Xcode
 * installed at the usual location.
 *
 * To rebuild it (only needed to pick up generator changes):
 *
 *     cd <napi-ios> && git checkout refactor && cd metadata-generator
 *     cmake -B build -DCMAKE_BUILD_TYPE=Release \
 *       -DMETADATA_BINARY_ARCH=arm64 -DCMAKE_OSX_ARCHITECTURES=arm64
 *     cmake --build build -j10
 *     cp build/bin/objc-metadata-generator <this repo>/example/scripts/bin/
 *
 * Point NAPI_IOS at a napi-ios checkout to use its `dist/arm64` build instead.
 *
 * The output lands in `ios/nativescript-metadata/` and is copied into the app
 * bundle by a build phase the Podfile installs. `NativeScriptNativeApiModule`
 * looks in the main bundle BEFORE the pod's own resource bundle, so ours wins
 * without touching the package.
 *
 * Simulator-only by default: this is an example, and the metadata is
 * arch-specific (`metadata.ios-sim.arm64.nsmd` vs `metadata.ios.arm64.nsmd`).
 * Pass `--device` to also emit the on-device variant.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const podHeaders = path.join(appRoot, 'ios', 'Pods', 'Headers', 'Public');
const outDir = path.join(appRoot, 'ios', 'nativescript-metadata');
// Outside the project on purpose: alongside the metadata the generator also
// emits a full set of TypeScript declarations for the SDK, and anything under
// the app root gets picked up by `tsc -p .` (those .d.ts files do not
// typecheck — `Accelerate.d.ts` alone uses `in` as a parameter name).
const workDir = path.join(os.tmpdir(), 'rn-workers-nativescript-metadata');

/** The checked-in generator — the default, so nothing needs compiling. */
const vendoredGenerator = path.join(here, 'bin', 'objc-metadata-generator');

/**
 * The header roots to expose to the generator, as `<name>` -> source directory.
 * Everything reachable from these is parsed and lands in the metadata, so this
 * is deliberately narrow: React-Core is where the `RCT*` classes live, and the
 * rest are only here because its headers import them.
 *
 * `RCTTypeSafety` is NOT included: `RCTTypedModuleConstants.h` is Obj-C++ and
 * fails to parse under `-std=gnu99` ("'type_traits' file not found"). Nothing
 * we want depends on it.
 *
 * FBLazyVector is here only so React-Core's imports of it resolve; its own
 * headers are C++ and log the same kind of parse error, which is harmless — the
 * header is skipped and everything else still lands.
 */
const HEADER_ROOTS = {
  React: ['React-Core', 'React'],
  RCTDeprecation: ['RCTDeprecation'],
  RCTRequired: ['RCTRequired', 'RCTRequired'],
  FBLazyVector: ['FBLazyVector', 'FBLazyVector'],
};

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

/**
 * Prefer the checked-in binary; NAPI_IOS overrides it with a local napi-ios
 * build, which is what you want while iterating on the generator itself.
 */
function generatorPath() {
  const candidates = [];
  if (process.env.NAPI_IOS) {
    candidates.push(
      path.join(
        process.env.NAPI_IOS,
        'metadata-generator',
        'dist',
        'arm64',
        'bin',
        'objc-metadata-generator'
      )
    );
  }
  candidates.push(vendoredGenerator);

  const exe = candidates.find((candidate) => fs.existsSync(candidate));
  if (!exe) {
    throw new Error(
      `objc-metadata-generator not found. Looked in:\n  ${candidates.join('\n  ')}`
    );
  }
  return exe;
}

/**
 * The umbrella builder walks every directory on clang's `<...>` search path but
 * skips symlinked directories outright (`Umbrella.cpp`: `!entry.is_symlink()`),
 * so the header tree has to be real files.
 */
function stageHeaders() {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  for (const [name, segments] of Object.entries(HEADER_ROOTS)) {
    const src = path.join(podHeaders, ...segments);
    if (!fs.existsSync(src)) {
      throw new Error(
        `missing pod headers: ${src} — run \`pod install\` first`
      );
    }
    fs.cpSync(src, path.join(workDir, name), {
      recursive: true,
      dereference: true,
    });
  }
  const count = sh('bash', [
    '-c',
    `find ${JSON.stringify(workDir)} -name '*.h' | wc -l`,
  ]);
  console.log(`staged ${count.trim()} headers from ${podHeaders}`);
}

function generate({ sdk, label, targetSuffix }) {
  const sdkPath = sh('xcrun', ['--sdk', sdk, '--show-sdk-path']);
  const sdkVersion = sh('xcrun', ['--sdk', sdk, '--show-sdk-version']);
  const outFile = path.join(outDir, `metadata.${label}.arm64.nsmd`);
  const typesDir = path.join(workDir, `types-${label}`);
  fs.mkdirSync(typesDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    `types=${typesDir}`,
    'ts-index-mode=all',
    '-verbose',
    '-output-bin',
    outFile,
    '-output-umbrella',
    path.join(workDir, `umbrella.${label}.h`),
    '-output-signature-bindings-cpp',
    path.join(workDir, `signatures.${label}.inc`),
    'Xclang',
    '-isysroot',
    sdkPath,
    '-std=gnu99',
    '-target',
    `arm64-apple-ios${sdkVersion}${targetSuffix}`,
    `-I${workDir}`,
  ];

  console.log(`\ngenerating ${path.relative(appRoot, outFile)} …`);
  execFileSync(generatorPath(), args, {
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const symbols = sh('bash', [
    '-c',
    `strings -a ${JSON.stringify(outFile)} | grep -cE '^RCT' || true`,
  ]);
  const size = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  console.log(`  ${size} MB · ${symbols} RCT-prefixed symbols`);
  if (Number(symbols) === 0) {
    throw new Error('no RCT symbols in the output — header staging failed');
  }
}

stageHeaders();
generate({
  sdk: 'iphonesimulator',
  label: 'ios-sim',
  targetSuffix: '-simulator',
});
if (process.argv.includes('--device')) {
  generate({ sdk: 'iphoneos', label: 'ios', targetSuffix: '' });
}
console.log('\nRebuild the app to pick up the new metadata.');
