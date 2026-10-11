// Liveness: is this process alive and serving HTTP?
//
// SEPARATE FROM /api/health ON PURPOSE, because the two questions have opposite
// remedies and answering both from one URL gets one of them wrong:
//
//   /api/health       READINESS. Configuration loaded, database readable.
//                     A 503 means "do not send this instance traffic" and is
//                     fixed by correcting the environment — NOT by restarting,
//                     which would produce a container that loops forever while
//                     the log repeats the same explanation nobody is reading.
//
//   /api/health/live  LIVENESS. The process is up. A failure here means the
//                     process is wedged and restarting it is the right move.
//
// Point a supervisor's restart policy at THIS one, and monitoring/proxy
// draining at the other. A supervisor pointed at readiness turns a typo in
// PCC_DATABASE_PATH into a restart loop; monitoring pointed at liveness reports
// green while the instance serves nothing.
//
// It deliberately touches NOTHING — no configuration, no database, no
// filesystem. A liveness probe that can fail for an external reason is a
// readiness probe with the wrong name.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'alive' }, { headers: { 'cache-control': 'no-store' } });
}
