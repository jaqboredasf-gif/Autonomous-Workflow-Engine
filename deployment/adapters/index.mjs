// ---------------------------------------------------------------------------
// adapters/index.mjs — where environment-specific mechanics live.
//
// THE BOUNDARY THIS DEFENDS. Everything in deployment/*.mjs is about the
// lifecycle: what is known, what blocks, what has been proven, what is ready.
// None of it should ever contain an `if (os === 'windows')`.
//
// The mechanics — which file supervises the process, which command enables it
// at boot, where things conventionally live — belong to an adapter, selected by
// one fact (`service.manager`). Adding Windows or a managed platform later
// means adding a file here, not editing the core.
//
// ONE REAL ADAPTER EXISTS. Linux/systemd, because that is what PCC actually
// deployed to. The others are named so the shape is visible and are absent so
// the shape stays honest: an adapter written for a platform nobody has used is
// a guess with a filename.
// ---------------------------------------------------------------------------

import { linuxSystemd } from './linux-systemd.mjs';

const ADAPTERS = {
  systemd: linuxSystemd,
  // 'docker-compose':  not yet written — PCC ships a compose file, but the
  //                    adapter shape has not been exercised against it.
  // 'windows-service': not yet written. Deliberately: no Windows deployment has
  //                    been performed, and writing it now would encode guesses.
  // 'platform-managed': not yet written.
};

/**
 * The adapter for a manifest, or a description of why there is not one.
 *
 * Returning a reason rather than throwing: "we do not support your service
 * manager yet" is a legitimate discovery outcome that should appear in a report
 * beside the other blockers, not as a crash.
 */
export function adapterFor(serviceManager) {
  if (!serviceManager) return { ok: false, reason: 'no service manager known yet' };
  const adapter = ADAPTERS[serviceManager];
  if (!adapter) {
    return {
      ok: false,
      reason: `no adapter for ${serviceManager}. Supported today: ${Object.keys(ADAPTERS).join(', ')}`,
    };
  }
  return { ok: true, adapter };
}

export const SUPPORTED_SERVICE_MANAGERS = Object.keys(ADAPTERS);
