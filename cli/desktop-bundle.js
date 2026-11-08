'use strict';

/**
 * Bundle hook for react-native-gpui (`platforms.desktop.bundleHook`): builds the
 * worker bundles a release app needs and hands back the folder to ship. The
 * desktop CLI runs it after the app's own bundle is built, so a release build
 * needs no extra step.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function bundleWorkers({
  projectRoot,
  bundleDir,
  entryFile,
  metroConfig,
}) {
  const args = [
    path.join(__dirname, 'index.js'),
    '--platform',
    'desktop',
    '--out',
    bundleDir,
    '--project-root',
    projectRoot,
  ];
  if (entryFile) args.push('--entry-file', entryFile);
  if (metroConfig) args.push('--config', metroConfig);
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: projectRoot });
  const workers = path.join(bundleDir, 'workers');
  return fs.existsSync(workers) ? [workers] : [];
};
