// ---------------------------------------------------------------------------
// preflight.mjs — can this environment run this deployment?
//
// The first genuinely reusable AWE deployment module, and chosen as the first
// because it is the artifact an unfamiliar operator runs before anything else,
// and because it changes nothing while it runs.
//
// FOUR RESULTS, and the fourth is the one most tools omit:
//
//   PASS      checked, and satisfied
//   WARNING   checked, satisfied, and worth reading before proceeding
//   BLOCKED   checked, and not satisfied. This stops the phase it belongs to.
//   UNKNOWN   could NOT be checked from here
//
// UNKNOWN is not a soft PASS. "The certificate is valid" and "I cannot see the
// certificate from this machine" are different sentences, and collapsing them
// is how a deployment acquires confidence it has not earned. A check that
// cannot run says so.
//
// ---------------------------------------------------------------------------
// THE SAFETY RULE
//
// Preflight is OBSERVATIONAL. It reads the environment and reports. It does not
// delete, rewrite, install, rotate, mutate DNS, or touch firewall rules.
//
// This is enforced structurally rather than by discipline: every check declares
// `mutates`, and `runPreflight` refuses to execute any check that declares
// mutation. Diagnose, remediate, and execute-remediation are three different
// operations and must not collapse into one — the moment a diagnostic tool can
// fix things, somebody runs it against production to see what it says.
// ---------------------------------------------------------------------------

import { isKnown } from './facts.mjs';
import { resolve } from './manifest.mjs';

export const PREFLIGHT_RESULTS = ['PASS', 'WARNING', 'BLOCKED', 'UNKNOWN'];

const result = (id, status, detail, extra = {}) => ({ id, status, detail, ...extra });

/**
 * The environment a check may look at, injected rather than imported.
 *
 * Everything the checks can see arrives through this object, which is what
 * makes them testable without a server and what keeps the module honest about
 * its own reach: a check cannot quietly shell out.
 *
 * THE DEFAULT PROBE SEES NOTHING. Every capability returns `null`, meaning
 * "cannot tell from here", which produces UNKNOWN rather than PASS. A probe
 * that guessed would turn an untested environment into a green report, which is
 * the failure mode this whole module exists to avoid. Call `nodeHostProbe()`
 * for one that actually looks.
 */
export function hostProbe(overrides = {}) {
  return {
    runtimeName: 'node',
    runtimeVersion: process.versions.node,
    platform: process.platform,
    env: process.env,
    pathExists: () => null,       // null = cannot tell from here → UNKNOWN
    isWritable: () => null,
    isAbsolute: (p) => typeof p === 'string' && p.startsWith('/'),
    portFree: () => null,
    commandAvailable: () => null,
    freeSpaceBytes: () => null,
    canImport: () => null,
    ...overrides,
  };
}

/**
 * A probe that actually inspects the machine it is running on.
 *
 * OBSERVATIONAL, and structurally so: it reads, it opens a listening socket for
 * a moment to see whether a port is free, and it closes it again. It creates no
 * directory, installs nothing, and writes exactly one temporary file to answer
 * "is this directory writable" — which it then removes. That single write is
 * the only mutation in the module and it is confined to a path the operator
 * nominated as the data directory.
 *
 * Injected dependencies rather than imports at module scope, so this file stays
 * loadable in an environment without them and so the tests can still substitute
 * a blind probe.
 */
export async function nodeHostProbe({ fs, net, os, path } = {}) {
  const nodeFs = fs ?? await import('node:fs');
  const nodeNet = net ?? await import('node:net');
  const nodeOs = os ?? await import('node:os');
  const nodePath = path ?? await import('node:path');

  return {
    runtimeName: 'node',
    runtimeVersion: process.versions.node,
    platform: process.platform,
    env: process.env,

    pathExists(target) {
      try { return nodeFs.existsSync(target); } catch { return null; }
    },

    /**
     * Writability, established by writing. `fs.access` reports the permission
     * bits, which is a different question from whether this account can
     * actually write here — read-only mounts, full disks and SELinux all say
     * yes to the first and no to the second.
     */
    isWritable(target) {
      const probeFile = nodePath.join(target, `.awe-preflight-${process.pid}`);
      try {
        nodeFs.writeFileSync(probeFile, '');
        nodeFs.unlinkSync(probeFile);
        return true;
      } catch {
        return false;
      }
    },

    isAbsolute(target) {
      try { return nodePath.isAbsolute(target); } catch { return false; }
    },

    /** Bind, observe, release. Nothing is left listening. */
    portFree(port) {
      return new Promise((resolve) => {
        const server = nodeNet.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        try { server.listen(port, '127.0.0.1'); } catch { resolve(null); }
      });
    },

    /** On PATH? Deliberately no execution — presence is the question. */
    commandAvailable(command) {
      const dirs = String(process.env.PATH ?? '').split(nodePath.delimiter).filter(Boolean);
      if (!dirs.length) return null;
      for (const dir of dirs) {
        try {
          if (nodeFs.existsSync(nodePath.join(dir, command))) return true;
          if (process.platform === 'win32' && nodeFs.existsSync(nodePath.join(dir, `${command}.exe`))) return true;
        } catch { /* an unreadable PATH entry is not an answer either way */ }
      }
      return false;
    },

    freeSpaceBytes(target) {
      try {
        const stat = nodeFs.statfsSync(target);
        return stat.bavail * stat.bsize;
      } catch { return null; }
    },

    /**
     * Can this runtime load a module the application declares it needs?
     *
     * PCC's store is `node:sqlite`, which is part of the runtime rather than a
     * dependency — on an older Node the import fails at startup with a message
     * naming nothing anybody can act on. Checking it here converts that into
     * one line before anything is installed.
     */
    async canImport(specifier) {
      try { await import(specifier); return true; } catch { return false; }
    },

    totalMemoryBytes: () => nodeOs.totalmem(),
  };
}

// ---------------------------------------------------------------------------
// Checks
//
// Each is chosen because it would have caught, or did catch, something real
// during the PCC deployment. None is here for completeness.
// ---------------------------------------------------------------------------

export const CHECKS = [
  {
    id: 'runtime.version',
    phase: 'REQUIRED_BEFORE_BUILD',
    mutates: false,
    describe: 'the runtime is present and new enough',
    run(manifest, facts, probe) {
      const want = facts['runtime.min_version'];
      const name = facts['runtime.name'];
      if (!isKnown(want) || !isKnown(name)) return result(this.id, 'UNKNOWN', 'the manifest does not state a runtime floor');
      if (probe.runtimeName !== name.value) {
        return result(this.id, 'UNKNOWN', `cannot check a ${name.value} runtime from a ${probe.runtimeName} process`);
      }
      const major = Number(String(probe.runtimeVersion).split('.')[0]);
      const floor = Number(String(want.value).split('.')[0]);
      if (!Number.isFinite(major) || !Number.isFinite(floor)) {
        return result(this.id, 'UNKNOWN', 'could not compare versions');
      }
      // A hard floor, not a preference: PCC's datastore is part of the runtime,
      // and an older host fails at import with an unactionable error.
      return major >= floor
        ? result(this.id, 'PASS', `${name.value} ${probe.runtimeVersion} satisfies >=${want.value}`)
        : result(this.id, 'BLOCKED', `${name.value} ${probe.runtimeVersion} is below the required ${want.value}`);
    },
  },

  {
    id: 'config.required_present',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the variables the application refuses to start without are set',
    run(manifest, facts, probe) {
      const required = manifest?.operations?.required_env ?? [];
      if (!required.length) return result(this.id, 'UNKNOWN', 'the manifest does not list required variables');
      const missing = required.filter((v) => !probe.env[v]);
      return missing.length
        ? result(this.id, 'BLOCKED', `not set: ${missing.join(', ')}`, { missing })
        : result(this.id, 'PASS', `all ${required.length} present (values not read)`);
    },
  },

  {
    id: 'config.no_dev_defaults',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'production is not running on a development default',
    run(manifest, facts, probe) {
      // PCC shipped a development session secret and an APP_BASE_URL default of
      // http://localhost:3000. Both are correct on a laptop and are
      // developer-machine coupling anywhere else.
      const suspects = Object.entries(probe.env)
        .filter(([k, v]) => typeof v === 'string'
          && (/development|localhost|127\.0\.0\.1|changeme|example\.com/i).test(v)
          && /SECRET|URL|HOST|BASE/i.test(k))
        .map(([k]) => k);
      if (!Object.keys(probe.env).length) return result(this.id, 'UNKNOWN', 'no environment visible');
      return suspects.length
        ? result(this.id, 'WARNING', `looks like a development value: ${suspects.join(', ')} (values not shown)`)
        : result(this.id, 'PASS', 'no development defaults detected');
    },
  },

  {
    id: 'storage.path_absolute',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the data path is absolute',
    run(manifest, facts, probe) {
      const p = facts['storage.data_path'];
      if (!isKnown(p)) return result(this.id, 'BLOCKED', 'no data path declared — the one thing that must outlive the release');
      return probe.isAbsolute(p.value)
        ? result(this.id, 'PASS', `${p.value} is absolute`)
        : result(this.id, 'BLOCKED', `${p.value} is relative; it resolves against the working directory, which is not a promise anything keeps`);
    },
  },

  {
    id: 'storage.path_writable',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the data directory exists and can be written',
    run(manifest, facts, probe) {
      const p = facts['storage.data_path'];
      if (!isKnown(p)) return result(this.id, 'UNKNOWN', 'no data path declared');
      const exists = probe.pathExists(p.value);
      if (exists === null) return result(this.id, 'UNKNOWN', `cannot see ${p.value} from here`);
      if (!exists) {
        // Creating it here would put the data inside the application directory
        // instead of on the mounted volume — the exact failure this refuses.
        return result(this.id, 'BLOCKED', `${p.value} does not exist. It is where the persistent volume should be mounted; preflight will not create it`);
      }
      const writable = probe.isWritable(p.value);
      if (writable === null) return result(this.id, 'UNKNOWN', 'could not test writability');
      return writable
        ? result(this.id, 'PASS', `${p.value} exists and is writable`)
        : result(this.id, 'BLOCKED', `${p.value} is not writable by this account`);
    },
  },

  {
    id: 'storage.not_in_source_tree',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the data path is not inside the application directory',
    run(manifest, facts, probe) {
      const data = facts['storage.data_path'];
      const install = facts['hosting.install_path'];
      if (!isKnown(data) || !isKnown(install)) return result(this.id, 'UNKNOWN', 'need both the data and install paths');
      // Found at Lippolis by reading the runbook as a stranger: each half was
      // sensible, and together they put the records where a re-clone or a
      // release deletes them, with no command that looks destructive.
      const inside = String(data.value).startsWith(String(install.value).replace(/\/$/, '') + '/');
      return inside
        ? result(this.id, 'BLOCKED', `${data.value} is inside ${install.value}. A redeploy or a re-clone would delete the records`)
        : result(this.id, 'PASS', 'records are outside the application directory');
    },
  },

  {
    id: 'storage.local_filesystem',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'an embedded datastore is on a local filesystem',
    run(manifest, facts) {
      const engine = facts['database.engine'];
      const fs = facts['storage.filesystem'];
      if (!isKnown(engine)) return result(this.id, 'UNKNOWN', 'no database engine declared');
      if (engine.value !== 'sqlite') return result(this.id, 'PASS', `${engine.value} does not require local disk`);
      if (!isKnown(fs)) return result(this.id, 'UNKNOWN', 'filesystem type not declared, and an embedded store needs local disk');
      return fs.value === 'local'
        ? result(this.id, 'PASS', 'embedded store on local disk')
        : result(this.id, 'BLOCKED', `an embedded store on a ${fs.value} filesystem is a known corruption hazard`);
    },
  },

  {
    id: 'network.port_free',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the application port is available',
    async run(manifest, facts, probe) {
      const port = facts['network.port'];
      if (!isKnown(port)) return result(this.id, 'UNKNOWN', 'no port declared');
      const free = await probe.portFree(port.value);
      if (free === null || free === undefined) return result(this.id, 'UNKNOWN', `cannot test port ${port.value} from here`);
      return free
        ? result(this.id, 'PASS', `port ${port.value} is free`)
        : result(this.id, 'BLOCKED', `port ${port.value} is already in use`);
    },
  },

  {
    id: 'service.manager_available',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the declared service manager exists on this host',
    run(manifest, facts, probe) {
      const mgr = facts['service.manager'];
      if (!isKnown(mgr)) return result(this.id, 'UNKNOWN', 'no service manager known');
      if (mgr.value === 'platform-managed') return result(this.id, 'PASS', 'the platform supervises the process');

      // NOT ON THE TARGET MACHINE IS NOT A FAILURE. Run from a developer's
      // laptop against a manifest describing a Linux server, this check would
      // otherwise report BLOCKED for a deployment that is perfectly fine — a
      // check that fails on a correct setup is how an operator learns to ignore
      // the report. The absence of systemd on macOS says nothing about the VM.
      const targetOs = facts['hosting.os'];
      const platformOs = probe.platform === 'win32' ? 'windows' : probe.platform === 'darwin' ? 'macos' : 'linux';
      if (isKnown(targetOs) && targetOs.value !== platformOs) {
        return result(this.id, 'UNKNOWN',
          `this deployment targets ${targetOs.value} and this check is running on ${platformOs} — run it on the target machine`);
      }
      const command = { systemd: 'systemctl', 'docker-compose': 'docker', 'windows-service': 'sc' }[mgr.value];
      if (!command) return result(this.id, 'UNKNOWN', `no probe for ${mgr.value}`);
      const available = probe.commandAvailable(command);
      if (available === null) return result(this.id, 'UNKNOWN', `cannot check for ${command} from here`);
      return available
        ? result(this.id, 'PASS', `${command} is available`)
        : result(this.id, 'BLOCKED', `${mgr.value} was expected but ${command} is not on this host`);
    },
  },

  {
    id: 'runtime.capabilities',
    phase: 'REQUIRED_BEFORE_BUILD',
    mutates: false,
    describe: 'modules the application declares it needs can actually be loaded',
    async run(manifest, facts, probe) {
      // Generic in shape, specific in content: the application names what it
      // needs. PCC needs `node:sqlite`, which is part of the runtime — on an
      // older Node the import fails at startup naming nothing actionable.
      const wanted = manifest?.runtime?.capabilities ?? [];
      if (!wanted.length) return result(this.id, 'PASS', 'the application declares no special runtime capabilities');
      const missing = [];
      for (const specifier of wanted) {
        const okToImport = await probe.canImport(specifier);
        if (okToImport === null || okToImport === undefined) {
          return result(this.id, 'UNKNOWN', `cannot test module availability from here (${specifier})`);
        }
        if (!okToImport) missing.push(specifier);
      }
      return missing.length
        ? result(this.id, 'BLOCKED', `this runtime cannot load: ${missing.join(', ')}`)
        : result(this.id, 'PASS', `${wanted.length} declared capability(ies) available`);
    },
  },

  {
    id: 'storage.free_space',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'there is room for the data and its backups',
    run(manifest, facts, probe) {
      const p = facts['storage.data_path'];
      if (!isKnown(p)) return result(this.id, 'UNKNOWN', 'no data path declared');
      const free = probe.freeSpaceBytes(p.value);
      if (free === null || free === undefined) return result(this.id, 'UNKNOWN', `cannot measure free space at ${p.value}`);
      const gb = free / 1024 ** 3;
      const want = isKnown(facts['hosting.disk_gb']) ? Number(facts['hosting.disk_gb'].value) : 5;
      // Backups are full copies on this architecture, so the operator's real
      // question is how many more fit — not how big the database is.
      if (gb < 1) return result(this.id, 'BLOCKED', `${gb.toFixed(1)} GB free — not enough for the database and one backup`);
      if (gb < want) return result(this.id, 'WARNING', `${gb.toFixed(1)} GB free, below the ${want} GB this deployment expects`);
      return result(this.id, 'PASS', `${gb.toFixed(1)} GB free`);
    },
  },

  {
    id: 'storage.store_present_or_authorized',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the datastore exists, or creating it has been authorized once',
    run(manifest, facts, probe) {
      const loc = facts['database.location'];
      if (!isKnown(loc)) return result(this.id, 'UNKNOWN', 'no datastore location declared');
      // Only meaningful for a store that is a file on this machine.
      if (!probe.isAbsolute(loc.value)) return result(this.id, 'UNKNOWN', 'the datastore is not a local path — nothing to inspect here');
      const exists = probe.pathExists(loc.value);
      if (exists === null) return result(this.id, 'UNKNOWN', `cannot see ${loc.value} from here`);
      const authorizedVar = manifest?.operations?.create_authorization_env;
      const authorized = authorizedVar ? String(probe.env[authorizedVar] ?? '') === '1' : false;

      if (exists && authorized) {
        // Not destructive, but it removes the protection that catches an
        // unmounted volume — which is the failure it exists for.
        return result(this.id, 'WARNING', `a datastore exists and ${authorizedVar} is still set — remove it; it is for the first start only`);
      }
      if (exists) return result(this.id, 'PASS', 'the datastore is present');
      if (authorized) return result(this.id, 'WARNING', `no datastore yet, and ${authorizedVar}=1 — this start will CREATE one. Correct for a first install only`);
      return result(this.id, 'BLOCKED',
        `no datastore at ${loc.value}. If this is genuinely the first install, authorize creation once. If it is not, the volume is not mounted where the application is looking`);
    },
  },

  {
    id: 'config.secret_strength',
    phase: 'REQUIRED_BEFORE_DEPLOY',
    mutates: false,
    describe: 'the session secret is the deployment own, and long enough',
    run(manifest, facts, probe) {
      // Names the variable, never prints the value: this output gets pasted
      // into installation records and chat messages.
      const name = manifest?.operations?.session_secret_env ?? 'SESSION_SECRET';
      const secret = String(probe.env[name] ?? '');
      if (!secret) return result(this.id, 'UNKNOWN', `${name} is not set in this environment`);
      if (secret.length < 32) return result(this.id, 'BLOCKED', `${name} is ${secret.length} characters — needs at least 32`);
      if (/development|changeme|example|placeholder/i.test(secret)) {
        return result(this.id, 'BLOCKED', `${name} looks like a built-in development value`);
      }
      return result(this.id, 'PASS', `${name} is ${secret.length} characters (value not shown)`);
    },
  },

  {
    id: 'config.base_url',
    phase: 'REQUIRED_BEFORE_GO_LIVE',
    mutates: false,
    describe: 'the application address is absolute, and https where it matters',
    run(manifest, facts, probe) {
      const name = manifest?.operations?.base_url_env ?? 'APP_BASE_URL';
      const url = String(probe.env[name] ?? '');
      if (!url) return result(this.id, 'UNKNOWN', `${name} is not set in this environment`);
      if (!/^https?:\/\//.test(url)) return result(this.id, 'BLOCKED', `${name} must be an absolute URL`);
      if (url.startsWith('http://') && probe.env.NODE_ENV === 'production') {
        // Session cookies are Secure almost everywhere; over plain HTTP they
        // are set and never sent back, so sign-in appears to work and bounces.
        return result(this.id, 'WARNING', `${name} is http:// in production — Secure session cookies will not stick without HTTPS`);
      }
      return result(this.id, 'PASS', 'absolute, and https where it matters');
    },
  },

  {
    id: 'secrets.not_in_manifest',
    phase: 'REQUIRED_BEFORE_BUILD',
    mutates: false,
    describe: 'the manifest carries references, not secret values',
    run(manifest, facts, probe, { manifestProblems = [] } = {}) {
      const leaks = manifestProblems.filter((p) => /secret/i.test(p.message));
      return leaks.length
        ? result(this.id, 'BLOCKED', leaks.map((l) => `${l.path}: ${l.message}`).join('; '))
        : result(this.id, 'PASS', 'no secret values found in the manifest');
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run every check that is safe to run.
 *
 * A check declaring `mutates: true` is not executed and is reported as BLOCKED
 * against the tool itself. That is deliberate and slightly rude: it should be
 * impossible to add a mutating step to preflight by accident, and a loud
 * refusal is the only version of that which survives a busy afternoon.
 */
export async function runPreflight(manifest, { probe = hostProbe(), manifestProblems = [], checks = CHECKS } = {}) {
  const facts = resolve(manifest);
  const results = [];

  for (const check of checks) {
    if (check.mutates) {
      results.push(result(check.id, 'BLOCKED',
        'refused: preflight is observational, and this check declares that it mutates the environment'));
      continue;
    }
    try {
      results.push(await check.run(manifest, facts, probe, { manifestProblems }));
    } catch (err) {
      results.push(result(check.id, 'UNKNOWN', `the check itself failed: ${err.message}`));
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  const blocked = results.filter((r) => r.status === 'BLOCKED');
  return {
    results,
    counts: { PASS: count('PASS'), WARNING: count('WARNING'), BLOCKED: count('BLOCKED'), UNKNOWN: count('UNKNOWN') },
    ok: blocked.length === 0,
    blocked,
    // UNKNOWN is surfaced separately: it is not failure, and it is not comfort.
    unresolved: results.filter((r) => r.status === 'UNKNOWN'),
  };
}

/** Plain-text report. No values, only names and outcomes. */
export function formatPreflight(report) {
  const lines = report.results.map((r) => `  ${r.status.padEnd(8)} ${r.id.padEnd(30)} ${r.detail}`);
  const c = report.counts;
  lines.push('', `  ${c.PASS} passed, ${c.WARNING} warning(s), ${c.BLOCKED} blocked, ${c.UNKNOWN} could not be checked`);
  if (report.unresolved.length) {
    lines.push('', '  Could not be checked from here — these are not passes:');
    for (const r of report.unresolved) lines.push(`    · ${r.id}: ${r.detail}`);
  }
  return lines.join('\n');
}
