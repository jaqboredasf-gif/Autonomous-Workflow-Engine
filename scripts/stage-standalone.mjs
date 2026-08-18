#!/usr/bin/env node
// ---------------------------------------------------------------------------
// stage-standalone.mjs — finish the production build.
//
// THE TRAP THIS CLOSES. `next build --output standalone` produces a server that
// runs, answers /api/health with 200, and serves a 404 for every stylesheet:
// Next does not fold `.next/static` or `public` into the standalone tree, and
// leaves copying them to whoever packages the application.
//
// The Dockerfile did that correctly, and the systemd unit documented the two
// rsync lines that do it by hand — but `npm start` run straight from the
// repository did not, which is the first thing anybody tries after a build. The
// result is an application that looks broken while every check says it is fine:
// health passes, the log says ready, and the page has no styling and no logo.
// That is a bad hour for somebody who has never seen the application working.
//
// So the copy happens HERE, as part of the build, and every deployment path
// gets the same finished directory: run it in place, rsync it to /opt/pcc, or
// COPY it into an image.
//
// Node rather than shell because the operating system of the build machine is
// not settled — Jose may build on Windows.
// ---------------------------------------------------------------------------
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'purchasing');
const STANDALONE = join(APP, '.next', 'standalone', 'apps', 'purchasing');

if (!existsSync(join(STANDALONE, 'server.js'))) {
  console.error(
    'stage-standalone: no standalone server at\n' +
    `  ${join(STANDALONE, 'server.js')}\n` +
    'Run the build first: npm run build --workspace purchasing',
  );
  process.exit(1);
}

// `.next/static` is required — without it the application renders unstyled.
// `public` is optional in principle and holds the logo in practice.
const copies = [
  { from: join(APP, '.next', 'static'), to: join(STANDALONE, '.next', 'static'), required: true },
  { from: join(APP, 'public'), to: join(STANDALONE, 'public'), required: false },
];

for (const { from, to, required } of copies) {
  if (!existsSync(from)) {
    if (required) {
      console.error(`stage-standalone: ${from} is missing — the build did not complete`);
      process.exit(1);
    }
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[pcc] staged ${from.replace(`${APP}/`, '')} -> standalone`);
}

// --- the release identifier -------------------------------------------------
// "EXACTLY WHAT VERSION IS RUNNING AT LIPPOLIS?" has to be answerable from the
// server, months later, by somebody who was not present when it was installed.
// /api/health already reports `release` from PCC_RELEASE — but nothing set it,
// so it answered null, and the question fell back to comparing file dates,
// which is how the wrong build gets blamed.
//
// So the build stamps it. The commit is the identity; the date is for humans
// reading a ticket. `-dirty` is deliberate and load-bearing: an artifact built
// from uncommitted changes cannot be reproduced from a commit, and production
// should say so out loud rather than name a commit that does not describe it.
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: join(APP, '..', '..'), encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
};
const sha = git('rev-parse', '--short', 'HEAD') || 'unknown';
const dirty = git('status', '--porcelain') ? '-dirty' : '';
const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const release = `${sha}${dirty} ${builtAt}`;

writeFileSync(join(STANDALONE, 'RELEASE'), `${release}\n`, 'utf8');
console.log(`[pcc] release: ${release}`);
if (dirty) {
  console.log('[pcc] WARNING: built from a dirty working tree. This artifact cannot be');
  console.log('[pcc]          reproduced from a commit. Commit first for a production release.');
}

console.log('[pcc] standalone output is complete and can be started, copied or imaged as one directory');
