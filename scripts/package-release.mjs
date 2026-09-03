// ---------------------------------------------------------------------------
// package-release.mjs — produce the thing the runbook tells the installer to copy.
//
// THE GAP THIS CLOSES. Step 1 of docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md,
// the authoritative Windows procedure, reads:
//
//     Copy PCC-<commit>.zip to the server; verify against its .sha256 file
//
// Nothing in this repository produced either file. The first instruction of the
// installation names an artifact that did not exist, which means deployment day
// would have started with somebody improvising a zip — including or excluding
// whatever they happened to think of, with no record of which.
//
//   node scripts/package-release.mjs
//   node scripts/package-release.mjs --out dist --allow-dirty
//
// WHAT GOES IN, and nothing else:
//
//   dist/pcc/              the staged production build — what -Artifact points at
//   scripts/              every script the installation runs, resolved by
//                         following imports rather than by a list somebody keeps
//   config/production.env.template
//   docs/deployment/       the procedure, so the server carries its own runbook
//   RELEASE, MANIFEST.txt  what this is, and exactly what is in it
//
// WHAT IT REFUSES:
//
//   · a dirty working tree — the RDS02 checklist step 8 says the release line
//     must show no `-dirty`, and an artifact built from uncommitted work is not
//     the installation of record. `--allow-dirty` exists for rehearsals and
//     stamps the package so it can never be mistaken for one.
//   · a build older than HEAD, because the commit on the label would not be the
//     code in the box.
//   · anything check-deployable.mjs refuses — a database, an env file, a key.
//     That check is not repeated here; it is run.
//
// DETERMINISTIC. Fixed timestamps, sorted entries, so the same commit produces
// the same bytes and the same sha256 on any machine. Two people building the
// approved commit can compare hashes and find out whether they built the same
// thing, which is the only reason to publish a hash at all.
//
// NO DEPENDENCY. The zip is written with node:zlib. Adding an archiver package
// to produce the artifact that carries the application would put a package
// nobody audited inside the supply chain of the deployment.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

const argv = process.argv.slice(2);
const arg = (k, d = null) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const flag = (k) => argv.includes(`--${k}`);

// Fixed archive timestamps, declared here rather than beside the writer below:
// `const` is not hoisted, and the writer is called from top-level code above
// its own definition. 12:00:00 on a fixed date, so the same input produces the
// same bytes.
const DOS_TIME = 0x6000;
const DOS_DATE = 0x5721;

// An absolute --out is used as given. `join(ROOT, '/tmp/x')` quietly produces
// a path inside the repository, which is how a build writes its artifact
// somewhere nobody looks.
const outArg = arg('out', 'dist');
const OUT = isAbsolute(outArg) ? outArg : R(outArg);
const STANDALONE = R('apps/purchasing/.next/standalone');
const STAGED_SERVER = join(STANDALONE, 'apps', 'purchasing', 'server.js');

const die = (...lines) => { for (const l of lines) console.error(l); process.exit(1); };
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';

// --- what are we packaging -------------------------------------------------
const commit = git('rev-parse', '--short', 'HEAD');
if (!commit) die('package-release: not a git checkout, so there is no commit to name.');
const dirty = git('status', '--porcelain').length > 0;
if (dirty && !flag('allow-dirty')) {
  die(
    'package-release: the working tree is dirty.',
    '',
    'An artifact built from uncommitted work is not the installation of record: the commit on',
    'the label is not the code in the box, and nothing afterwards can tell which lines differed.',
    'The RDS02 checklist step 8 requires a release line with no `-dirty`.',
    '',
    'Commit the work, or pass --allow-dirty for a rehearsal package (which is stamped as one).');
}

if (!existsSync(STAGED_SERVER)) {
  die(`package-release: no production build at ${STAGED_SERVER}.`,
    'Run: npm run build --workspace purchasing');
}

// The build must be at least as new as the commit it will be labelled with.
const headTime = Number(git('log', '-1', '--format=%ct')) * 1000;
const builtTime = statSync(STAGED_SERVER).mtimeMs;
if (Number.isFinite(headTime) && builtTime < headTime) {
  die('package-release: the build is older than HEAD.',
    `  built  ${new Date(builtTime).toISOString()}`,
    `  commit ${new Date(headTime).toISOString()}`,
    'Rebuild, or the commit on the label is not the code in the box.');
}

// --- what must not be in it ------------------------------------------------
// Not reimplemented. The existing check is the authority on what may not ship.
{
  const r = spawnSync(process.execPath, [R('scripts/check-deployable.mjs'), STANDALONE],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    die('package-release: check-deployable refused this build.', r.stdout ?? '', r.stderr ?? '');
  }
}

// --- which scripts the installation actually needs -------------------------
//
// FOLLOWED, NOT LISTED. The entry points are the commands the RDS02 procedure
// runs; everything they import comes along automatically. A hand-maintained
// list is how a package ships without scripts/lib/db.mjs and fails on the
// server with a module-not-found error at the worst possible moment.
const ENTRY_SCRIPTS = [
  'scripts/Deploy-PCCProduction.ps1',
  'scripts/preflight-windows.ps1',
  'scripts/install-production.ps1',
  'scripts/Configure-PCCIIS.ps1',
  'scripts/install-backup-task.ps1',
  'scripts/pcc-preflight.mjs',
  'scripts/pcc-verify-deployment.mjs',
  'scripts/pcc-verify-production.mjs',
  'scripts/pcc-backup.mjs',
  'scripts/pcc-restore.mjs',
  'scripts/pcc-storage-status.mjs',
  'scripts/pcc-reset-admin.mjs',
];

/** Every local module an entry script pulls in, transitively. */
function resolveImports(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = R(rel);
    if (!existsSync(abs)) die(`package-release: ${rel} does not exist, and the installation runs it.`);
    seen.add(rel);
    if (!/\.mjs$/.test(rel)) continue;
    const src = readFileSync(abs, 'utf8');
    const specs = [
      ...src.matchAll(/(?:^|[^.\w])import\s+[^'"]*from\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;               // node: builtins and packages
      const target = relative(ROOT, join(dirname(abs), spec)).split(sep).join('/');
      queue.push(target);
    }
  }
  return [...seen].sort();
}

const scripts = resolveImports(ENTRY_SCRIPTS);

// Paths assembled from `join(ROOT, ...)` at runtime cannot be found by reading
// imports, and the packager's own self-check below is what caught this: the
// first package it built loaded five scripts cleanly and failed the sixth with
// ERR_MODULE_NOT_FOUND, which is precisely the error an installer would have
// met on the server instead.
//
// So: named here, and the self-check is what proves the list is complete
// rather than the list being trusted.
const RUNTIME_PATHS = [
  'scripts/pcc-verify-production.mjs',           // spawned by the verifier
  'scripts/pcc-backup.mjs',                      // spawned by the verifier
  // Imported by pcc-verify-deployment.mjs so its report cannot disagree with
  // what the application does on start.
  'apps/purchasing/src/purchasing/infrastructure/env.ts',
  'apps/purchasing/src/purchasing/organization/po-numbering.mjs',
  // Imported by pcc-verify-deployment.mjs so an installation can be compared to
  // the record a person signed, using the same parse the gate uses.
  'deployment/approval-record.mjs',
];
for (const extra of RUNTIME_PATHS) if (!scripts.includes(extra)) scripts.push(extra);
scripts.sort();

const DOCS = [
  'PCC_VM_INSTALLATION_RUNBOOK.md',
  'SOURCE_OF_TRUTH.md',
  'deployment/APPROVED_RELEASE.md',
  ...readdirSync(R('docs/deployment')).filter((f) => f.endsWith('.md')).sort()
    .map((f) => `docs/deployment/${f}`),
].filter((f) => existsSync(R(f)));

// --- assemble --------------------------------------------------------------
const name = `PCC-${commit}${dirty ? '-dirty' : ''}`;
const files = [];                                   // { path: in-zip, bytes }
const add = (inZip, bytes) => files.push({ path: inZip, bytes });
const addFile = (inZip, absPath) => add(inZip, readFileSync(absPath));

/** Copy a directory into the package, sorted, so the archive is deterministic. */
function addTree(absDir, inZipPrefix) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      const rel = relative(absDir, abs).split(sep).join('/');
      addFile(posix.join(inZipPrefix, rel), abs);
    }
  };
  walk(absDir);
}

addTree(STANDALONE, `${name}/dist/pcc`);
for (const s of scripts) addFile(`${name}/${s}`, R(s));
addFile(`${name}/config/production.env.template`, R('config/production.env.template'));
for (const d of DOCS) addFile(`${name}/${d}`, R(d));

const release = existsSync(join(STANDALONE, 'apps', 'purchasing', 'RELEASE'))
  ? readFileSync(join(STANDALONE, 'apps', 'purchasing', 'RELEASE'), 'utf8').trim()
  : `${commit}${dirty ? '-dirty' : ''}`;
add(`${name}/RELEASE`, Buffer.from(`${release}\n`));

const manifest = [
  `PCC deployment package`,
  `=`.repeat(60),
  ``,
  `commit          ${commit}${dirty ? '  *** DIRTY — REHEARSAL ONLY, NOT AN INSTALLATION OF RECORD ***' : ''}`,
  `release line    ${release}`,
  `built from      ${git('rev-parse', '--abbrev-ref', 'HEAD')}`,
  `files           ${files.length + 1}`,
  ``,
  `HOW TO USE IT, on Windows Server 2019:`,
  ``,
  `  1. Verify the hash against ${name}.zip.sha256 before extracting.`,
  `  2. Right-click the zip -> Properties -> Unblock, then extract to C:\\pcc-artifact`,
  `  3. cd C:\\pcc-artifact\\${name}`,
  `  4. Fill in config\\production.env.template -> C:\\ProgramData\\pcc\\pcc.env`,
  `     PCC_ENVIRONMENT=production and PCC_ORG_ID=lippolis are written into the`,
  `     database when it is created and never again. A start that disagrees with`,
  `     what the database already says refuses to start and changes nothing.`,
  `  5. .\\scripts\\Deploy-PCCProduction.ps1 -FirstInstall -Artifact .\\dist\\pcc`,
  ``,
  `The full procedure is docs\\deployment\\PCC_RDS02_EXECUTION_PACKAGE.md, which`,
  `is inside this package. Read it with the server in front of you.`,
  ``,
  `WHAT IS NOT PROVEN: no Windows installation has been performed. The tooling`,
  `is covered by scripts/eval-windows-deployment.mjs and the application by a`,
  `local rehearsal; the SERVER is what the first supervised install proves.`,
  ``,
  `CONTENTS`,
  ...files.map((f) => `  ${f.path.slice(name.length + 1)}`),
].join('\n');
add(`${name}/MANIFEST.txt`, Buffer.from(`${manifest}\n`));

files.sort((a, b) => a.path.localeCompare(b.path));

// --- write the archive -----------------------------------------------------
mkdirSync(OUT, { recursive: true });
const zipPath = join(OUT, `${name}.zip`);
rmSync(zipPath, { force: true });
rmSync(`${zipPath}.sha256`, { force: true });

// --- prove the package is complete BEFORE writing it -----------------------
//
// Before, not after: a package that failed verification must not exist on disk
// at all. Written first and deleted on failure, there is a window in which a
// broken archive is sitting in dist/ looking exactly like a good one, and the
// person who copies it to the server is not the person who read the error.
//
// A package that is missing one module is indistinguishable from a good one
// until somebody runs it, and the somebody is an installer on a server with no
// internet and a person waiting. So every packaged script is loaded here, out
// of the assembled tree, and an unresolvable import fails THIS command.
{
  const staging = join(OUT, `.verify-${name}`);
  rmSync(staging, { recursive: true, force: true });
  for (const f of files) {
    const target = join(staging, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
  const root = join(staging, name);
  const broken = [];
  for (const s of scripts.filter((x) => x.endsWith('.mjs'))) {
    const r = spawnSync(process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(`file://${join(root, s)}`)})`],
      { cwd: root, encoding: 'utf8', timeout: 30_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(out)) {
      broken.push(`${s}: ${(/Cannot find (?:module|package) '([^']+)'/.exec(out)?.[1]) ?? 'an import'}`);
    }
  }
  if (!existsSync(join(root, 'dist', 'pcc', 'apps', 'purchasing', 'server.js'))) {
    broken.push('dist/pcc/apps/purchasing/server.js is missing — the installer has nothing to install');
  }
  rmSync(staging, { recursive: true, force: true });
  if (broken.length) {
    die('package-release: the package is incomplete and was not written.',
      '',
      ...broken.map((b) => `  · ${b}`),
      '',
      'Add the missing path to RUNTIME_PATHS in this script. A path assembled with',
      'join(ROOT, ...) at runtime cannot be found by reading imports, and shipping',
      'without it fails on the server rather than here.');
  }
}


writeFileSync(zipPath, zip(files));

const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${digest}  ${name}.zip\n`);

console.log(`package-release: ${zipPath}`);
console.log(`  release   ${release}`);
console.log(`  files     ${files.length}`);
console.log(`  bytes     ${statSync(zipPath).size.toLocaleString()}`);
console.log(`  sha256    ${digest}`);
console.log('');
console.log('Verify on the server before extracting:');
console.log(`  Get-FileHash -Algorithm SHA256 ${name}.zip`);
if (dirty) {
  console.log('');
  console.log('*** DIRTY TREE. This is a rehearsal package and is stamped as one. ***');
}

// ---------------------------------------------------------------------------
// A minimal, deterministic ZIP writer.
//
// Fixed DOS timestamps and sorted entries, so the same input produces the same
// bytes — which is what makes publishing a hash worth anything: two people can
// build the approved commit and find out whether they built the same thing.
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = Buffer.from(e.path, 'utf8');
    const deflated = deflateRawSync(e.bytes, { level: 9 });
    // Store when deflating did not help; a larger "compressed" member is silly
    // and some tools notice.
    const stored = deflated.length >= e.bytes.length;
    const body = stored ? e.bytes : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(e.bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);              // version made by
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.bytes.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(0, 38);              // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
