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
import { cpSync, existsSync, mkdirSync } from 'node:fs';
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

console.log('[pcc] standalone output is complete and can be started, copied or imaged as one directory');
