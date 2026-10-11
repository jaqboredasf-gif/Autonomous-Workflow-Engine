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
// TWO ADAPTERS EXIST; ONE HAS A DEPLOYMENT BEHIND IT. Linux/systemd was
// written from a PCC installation that happened. Windows was written against a
// named, confirmed target — LIPELE-RDS02, Windows Server 2019 — that has not
// been installed to yet, and it says so in its own `proven: false`. The
// distinction matters more than the file count: `adapterFor` answering `ok`
// means "the mechanics are written down", never "this has worked somewhere".
// Ask `provenAdapters()` for the stronger claim.
//
// The remaining names are absent so the shape stays honest: an adapter written
// for a platform nobody has a target on is a guess with a filename.
// ---------------------------------------------------------------------------

import { linuxSystemd } from './linux-systemd.mjs';
import { windowsService } from './windows-service.mjs';

const ADAPTERS = {
  systemd: linuxSystemd,
  'windows-service': windowsService,
  // 'docker-compose':  not yet written — PCC ships a compose file, but the
  //                    adapter shape has not been exercised against it.
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

/**
 * The adapters with a completed deployment behind them.
 *
 * Kept separate from SUPPORTED_SERVICE_MANAGERS because the two answer
 * different questions, and conflating them is how "we have a Windows adapter"
 * becomes "Windows works". A report that wants to claim proven mechanics should
 * read this one.
 */
export function provenAdapters() {
  return Object.entries(ADAPTERS)
    .filter(([, adapter]) => adapter.proven !== false)
    .map(([name]) => name);
}
