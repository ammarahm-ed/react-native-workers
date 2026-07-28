#!/usr/bin/env node
// Local compatibility-matrix runner.
//
// Packs the library once, then for each requested React Native version / Expo SDK
// it scaffolds a fresh consumer app under `.matrix/<name>/`, installs the packed
// tarball, and compiles the native code (Android by default; iOS with --platform
// ios). It's the local twin of .github/workflows/compat-matrix.yml — same idea,
// but you can debug a failure and re-run just that version in seconds instead of
// waiting on CI.
//
// Resumable: results are recorded in `.matrix/results.json`. A target that already
// PASSED is skipped on the next run; FAILED / new targets are (re)built. After
// fixing the library, `--pack` rebuilds the tarball and failed apps pick it up
// (the app scaffold is reused — only the tarball is reinstalled + rebuilt).
//
// Examples:
//   yarn matrix                      # all RN + Expo, Android, pack first
//   yarn matrix --rn=0.86            # just RN 0.86
//   yarn matrix --expo=57 --pack     # repack lib, build Expo SDK 57
//   yarn matrix --only=rn --force    # rebuild every RN target from scratch
//   yarn matrix --platform=ios --rn=latest
//
// Flags:
//   --rn=a,b       RN minors to run (default: 0.81..0.86,latest,next)
//   --expo=a,b     Expo SDKs to run (default: 54..57,latest)
//   --only=rn|expo run only one side of the matrix
//   --platform=    android (default) | ios
//   --pack         (re)build + repack the library tarball before running
//   --force        rebuild even targets recorded as PASS (re-scaffolds the app)
//   --bail         stop at the first failure (default: keep going)

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_DIR = path.join(ROOT, '.matrix');
const TARBALL = path.join(MATRIX_DIR, 'react-native-workers.tgz');

const DEFAULT_RN = ['0.81', '0.82', '0.83', '0.84', '0.85', '0.86', 'latest', 'next'];
const DEFAULT_EXPO = ['54', '55', '56', '57', 'latest'];

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const platform = args.platform === 'ios' ? 'ios' : 'android';
const only = args.only; // 'rn' | 'expo' | undefined
const doPack = !!args.pack;
const force = !!args.force;
const bail = !!args.bail;
const rnList = args.rn ? String(args.rn).split(',') : DEFAULT_RN;
const expoList = args.expo ? String(args.expo).split(',') : DEFAULT_EXPO;

// Scaffolds, logs and results are namespaced BY PLATFORM so an android and an ios
// sweep can run at the same time. They previously shared `.matrix/<dir>`, so a
// parallel run had each process re-scaffolding (and deleting) the directory the
// other was building in — surfacing as "scaffold failed" / ENOTEMPTY rather than
// anything to do with the library. The packed tarball stays shared: it is written
// once by --pack and only read afterwards.
const PLATFORM_DIR = path.join(MATRIX_DIR, platform);
const RESULTS = path.join(MATRIX_DIR, `results-${platform}.json`);
fs.mkdirSync(PLATFORM_DIR, { recursive: true });

// ---- helpers ----
const log = (...m) => console.log('[matrix]', ...m);
const die = (m) => {
  console.error('[matrix] FATAL:', m);
  process.exit(1);
};

// Subshell env: prepend THIS node's bin dir so `bash -c` (non-login) resolves the
// same working node/npm/npx as the runner — bypassing a Volta shim that has no
// default version in a fresh scratch dir. A login shell (`-l`) would re-trigger it.
const CHILD_ENV = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
};

/** Run a command, streaming its output into `<dir>/build.log`. Returns true on success. */
function run(cmd, cwd, logPath) {
  fs.appendFileSync(logPath, `\n$ ${cmd}\n`);
  const fd = fs.openSync(logPath, 'a');
  const res = spawnSync('bash', ['-c', cmd], { cwd, env: CHILD_ENV, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  return res.status === 0;
}

function resolveNpmVersion(spec) {
  const out = execSync(`npm view "react-native@${spec}" version`, {
    encoding: 'utf8',
    env: CHILD_ENV,
  }).trim();
  // npm may print multiple lines for ranges; take the last (highest).
  return out.split('\n').pop().replace(/.*'([^']+)'.*/, '$1').trim() || out;
}

function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  } catch {
    return {};
  }
}
function saveResults(r) {
  fs.writeFileSync(RESULTS, JSON.stringify(r, null, 2));
}

// ---- pack the library ----
function packLibrary() {
  log('building + packing the library…');
  execSync('yarn prepare', { cwd: ROOT, stdio: 'inherit', env: CHILD_ENV });
  // npm pack prints the tarball name; capture and move to a stable path.
  const name = execSync('npm pack --pack-destination "' + MATRIX_DIR + '"', {
    cwd: ROOT,
    encoding: 'utf8',
    env: CHILD_ENV,
  })
    .trim()
    .split('\n')
    .pop()
    .trim();
  fs.renameSync(path.join(MATRIX_DIR, name), TARBALL);
  log('packed →', path.relative(ROOT, TARBALL));
}

// ---- scaffolding ----
// Log to a SIBLING file (`.matrix/<dir>.log`), never inside the app dir — the
// scaffolders (cli init / create-expo-app) refuse a non-empty target dir.
const logPathFor = (dir) => path.join(PLATFORM_DIR, `${dir}.log`);

function scaffoldRn(fullVersion, dir) {
  const abs = path.join(PLATFORM_DIR, dir);
  const logPath = logPathFor(dir);
  fs.rmSync(abs, { recursive: true, force: true }); // init needs a fresh directory
  fs.writeFileSync(logPath, `# ${dir} — react-native ${fullVersion}\n`);
  // New Architecture is the default on RN 0.81+ (required by this library).
  const ok = run(
    `npx --yes @react-native-community/cli@latest init MatrixApp ` +
      `--directory "${abs}" --version "${fullVersion}" --pm npm --skip-git-init --install-pods false`,
    PLATFORM_DIR,
    logPath
  );
  return { ok, logPath };
}

function scaffoldExpo(sdk, dir) {
  const abs = path.join(PLATFORM_DIR, dir);
  const logPath = logPathFor(dir);
  // create-expo-app wants a non-existing (or empty) target dir.
  fs.rmSync(abs, { recursive: true, force: true });
  fs.writeFileSync(logPath, `# ${dir} — expo sdk ${sdk}\n`);
  // Scaffold directly from the SDK-PINNED blank template (dist-tag `sdk-54`, …).
  // Downgrading a latest-SDK template instead conflicts on expo-router peers.
  const template =
    sdk === 'latest' ? 'expo-template-blank' : `expo-template-blank@sdk-${sdk}`;
  const ok =
    run(
      `npx --yes create-expo-app@latest "${abs}" --no-install --yes --template ${template}`,
      PLATFORM_DIR,
      logPath
    ) &&
    run(`npm install --legacy-peer-deps`, abs, logPath) &&
    run(`npx expo install expo-device expo-crypto`, abs, logPath) &&
    run(`npx expo prebuild --platform ${platform} --no-install`, abs, logPath);
  return { ok, logPath };
}

function installTarball(dir, logPath) {
  const abs = path.join(PLATFORM_DIR, dir);
  // --legacy-peer-deps so a prerelease RN (the `next`/nightly channel) doesn't fail
  // the install on a strict peer-range mismatch — we still want the compile signal.
  return run(`npm install "${TARBALL}" --legacy-peer-deps`, abs, logPath);
}

// RN 0.81/0.82 vendor an fmt whose format-string check is `consteval`, and Xcode
// >= 26.2 rejects it ("call to consteval function … is not a constant expression").
// It is an upstream incompatibility reproducible in a stock RN app — but left
// alone it makes those two targets permanently un-buildable on a modern Xcode,
// which turns the OLDEST supported versions into the matrix's blind spot. That is
// exactly where cross-version breaks hide.
//
// fmt itself provides the opt-out: `FMT_USE_CONSTEVAL` is honoured when defined
// externally, and 0 downgrades the check from compile-time to run-time. Define it
// in the header rather than through xcodebuild or an extra `post_install`: a
// command-line `GCC_PREPROCESSOR_DEFINITIONS` outranks every per-target value
// (dropping COCOAPODS=1, RCT_METRO_PORT, …), and a second `post_install` block
// silently REPLACES React Native's own.
//
// Only the scaffold's disposable Pods/ is touched, only for the affected versions,
// so every other target still reports what a real app would see.
function relaxFmtConsteval(abs, logPath) {
  // Rooted at ios/, not ios/Pods: RN ships fmt through a prebuilt
  // `ReactNativeDependencies.xcframework` whose Headers/fmt is a SEPARATE copy
  // from the CocoaPods one, and it is the copy the compiler actually reads.
  // Patching only Pods/ reported success and changed nothing.
  const searchRoot = path.join(abs, 'ios');
  const MARKER = '/* [matrix] consteval disabled */';
  let patched = 0;
  // Pods/Headers/** are SYMLINKS into the pod source, so the same header is
  // reachable by several paths — resolve to the real file and patch it once.
  // CocoaPods also leaves those sources read-only, hence the chmod.
  const seen = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // fmt moved the macro from core.h to base.h; patch whichever exists.
      if (entry.name !== 'base.h' && entry.name !== 'core.h') continue;
      if (path.basename(dir) !== 'fmt') continue;
      let real;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue; // dangling symlink
      }
      if (seen.has(real)) continue;
      seen.add(real);
      try {
        const source = fs.readFileSync(real, 'utf8');
        if (source.includes(MARKER)) continue; // already patched
        // Defining FMT_USE_CONSTEVAL=0 from outside is NOT enough: only newer
        // fmt honours a pre-existing definition ("Use the provided definition"),
        // and the version RN 0.81/0.82 vendor redefines it unconditionally — the
        // header was rewritten, reported as patched, and changed nothing.
        // Neutralise the macro where it is defined instead.
        const next = source.replace(
          /#(\s*)define(\s+)FMT_CONSTEVAL(\s+)consteval/g,
          `#$1define$2FMT_CONSTEVAL ${MARKER}`
        );
        if (next === source) continue; // nothing to disable in this header
        fs.chmodSync(real, 0o644);
        fs.writeFileSync(real, next);
        patched += 1;
      } catch (err) {
        fs.appendFileSync(
          logPath,
          `\n[matrix] could not patch ${real}: ${err.message}\n`
        );
      }
    }
  };
  walk(searchRoot);
  fs.appendFileSync(
    logPath,
    `\n[matrix] relaxed fmt consteval in ${patched} header(s) — see relaxFmtConsteval()\n`
  );
  return patched > 0;
}

// The RN versions that need the fmt workaround above.
const NEEDS_FMT_RELAX = /^rn_0\.(81|82)$/;

function build(dir, logPath) {
  const abs = path.join(PLATFORM_DIR, dir);
  if (platform === 'android') {
    return run(
      `cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a --console=plain`,
      abs,
      logPath
    );
  }
  // iOS. The .xcworkspace is created BY `pod install`, so it can only be
  // discovered afterwards — reading the directory first finds nothing on a fresh
  // scaffold and hands xcodebuild the literal string "undefined".
  if (!run(`cd ios && pod install`, abs, logPath)) return false;
  // After pod install (fmt is fetched by CocoaPods), before xcodebuild.
  if (NEEDS_FMT_RELAX.test(dir)) relaxFmtConsteval(abs, logPath);
  const iosDir = path.join(abs, 'ios');
  const workspace = fs.readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'));
  if (!workspace) {
    fs.appendFileSync(
      logPath,
      `\n[matrix] no .xcworkspace in ${iosDir} after pod install\n`
    );
    return false;
  }
  const scheme = workspace.replace('.xcworkspace', '');
  // -derivedDataPath keeps Xcode's build output INSIDE the scaffold instead of the
  // shared ~/Library/Developer/Xcode/DerivedData. Two reasons: cleanupTarget() can
  // then reclaim everything by deleting one directory, and a matrix run never
  // evicts or grows the developer's own DerivedData. A full sweep otherwise adds
  // tens of GB and has filled the disk mid-run.
  return run(
    `cd ios && xcodebuild -workspace "${workspace}" -scheme "${scheme}" ` +
      `-configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' ` +
      `-derivedDataPath build/DerivedData ` +
      `build CODE_SIGNING_ALLOWED=NO`,
    abs,
    logPath
  );
}

// ---- targets ----
const targets = [];
if (only !== 'expo') {
  for (const rn of rnList) targets.push({ kind: 'rn', spec: rn, dir: `rn_${rn}` });
}
if (only !== 'rn') {
  for (const sdk of expoList) targets.push({ kind: 'expo', spec: sdk, dir: `expo_${sdk}` });
}

// ---- run ----
fs.mkdirSync(MATRIX_DIR, { recursive: true });
if (doPack || !fs.existsSync(TARBALL)) packLibrary();
else log('reusing existing tarball (pass --pack to rebuild):', path.relative(ROOT, TARBALL));

const results = loadResults();
// Reclaim a finished target's disk before moving to the next one.
//
// Each scaffold is a full app (node_modules + Pods/Gradle output + DerivedData),
// several GB each; a 13-target sweep otherwise needs 40 GB+ and has run the disk
// to 0, which fails builds in ways that look like real compile errors. The log
// and results.json are the durable artefacts, and both live outside `dir`.
function cleanupTarget(dir) {
  const abs = path.join(PLATFORM_DIR, dir);
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    // Best-effort: never fail a run over cleanup.
  }
}

for (const t of targets) {
  const key = `${platform}:${t.dir}`;
  if (!force && results[key]?.status === 'pass') {
    log(`SKIP ${key} (already passing; --force to rebuild)`);
    continue;
  }
  const abs = path.join(PLATFORM_DIR, t.dir);
  const logPath = logPathFor(t.dir);
  // "Scaffolded" requires BOTH package.json AND the native dir — a target that
  // failed at scaffold (e.g. prebuild never produced `android/`) must be redone,
  // not reused. Only a target that got a full scaffold (and maybe failed at build)
  // is reused so we just reinstall the tarball + rebuild.
  const scaffolded =
    !force &&
    fs.existsSync(path.join(abs, 'package.json')) &&
    fs.existsSync(path.join(abs, platform));

  log(`── ${key} ──`);
  try {
    let resolved = t.spec;
    if (t.kind === 'rn' && !scaffolded) resolved = resolveNpmVersion(t.spec);

    if (!scaffolded) {
      log(`scaffolding ${t.kind} ${t.kind === 'rn' ? resolved : 'sdk ' + t.spec}…`);
      const s = t.kind === 'rn' ? scaffoldRn(resolved, t.dir) : scaffoldExpo(t.spec, t.dir);
      if (!s.ok) throw new Error(`scaffold failed — see ${path.relative(ROOT, s.logPath)}`);
    } else {
      log('reusing existing app scaffold');
    }

    log('installing library tarball…');
    if (!installTarball(t.dir, logPath)) throw new Error('tarball install failed');

    log(`building (${platform})… this is the slow part`);
    if (!build(t.dir, logPath)) throw new Error(`build failed — see ${path.relative(ROOT, logPath)}`);

    results[key] = { status: 'pass', spec: t.spec, at: new Date().toISOString() };
    log(`PASS ${key}`);
    cleanupTarget(t.dir);
  } catch (e) {
    results[key] = { status: 'fail', spec: t.spec, error: String(e.message || e) };
    log(`FAIL ${key}: ${e.message || e}`);
    // Surface the tail of the build log for quick diagnosis.
    try {
      const tail = execSync(`tail -40 "${logPath}"`, { encoding: 'utf8' });
      console.log(tail);
    } catch {}
    if (bail) {
      saveResults(results);
      die(`bailing at first failure (${key})`);
    }
    // Reclaim the failed target too: its log already holds the diagnosis, and
    // leaving several GB behind is what fills the disk during a long sweep.
    cleanupTarget(t.dir);
  }
  saveResults(results);
}

// ---- summary ----
// Pre-release channels (RN `next`) are early-warning only: a break there flags an
// UPCOMING RN/Expo release, not a regression in a supported version, so it's shown
// but doesn't fail the run.
const PRERELEASE = new Set(['next']);
saveResults(results);
log('──────── summary ────────');
let fails = 0;
for (const t of targets) {
  const r = results[`${platform}:${t.dir}`];
  const s = r?.status ?? 'skip';
  const info = PRERELEASE.has(t.spec);
  if (s === 'fail' && !info) fails++;
  const icon = s === 'pass' ? '✅' : s === 'fail' ? (info ? '⚠️' : '❌') : '·';
  const note = s === 'fail' && info ? ' — pre-release, informational (see notes)' : '';
  log(`${icon} ${platform}:${t.dir} (${s})${note}`);
}
process.exit(fails > 0 ? 1 : 0);
