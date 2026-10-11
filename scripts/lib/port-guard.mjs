// ---------------------------------------------------------------------------
// port-guard.mjs — refuse to test against somebody else's application.
//
// THE FAILURE THIS EXISTS TO PREVENT, which cost a session's confidence:
//
// A container from an earlier test run was still up, bound to 0.0.0.0:3399. A
// new rehearsal built a fresh image, started its own container on 127.0.0.1:3399
// — and every request went to the FOUR-HOUR-OLD ONE. The results were internally
// consistent and completely wrong: a route added that morning answered 404, a
// warning removed that morning was still in the health output, and the
// administrator the new container had just created could not sign in.
//
// Each of those looked like a serious defect in new code. All three were one
// stale process. The wasted hour was not the expensive part — nearly shipping a
// "finding" about code that was fine was.
//
// The lesson generalizes past this repository: an integration test that assumes
// the thing answering is the thing it started will eventually be wrong, and it
// fails in the direction of a confident false result rather than an error.
//
// So: before starting, prove the port is FREE. After starting, prove the thing
// answering is the one just started.
// ---------------------------------------------------------------------------

/**
 * Is anything already listening here?
 *
 * Deliberately asks over HTTP rather than by binding a socket: a container
 * publishing a port holds it in the host's network namespace, and a bind check
 * from this process can succeed while Docker still routes the traffic
 * elsewhere. What matters is not whether the port is bindable — it is whether
 * something ANSWERS.
 */
export async function portIsOccupied(baseUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
    return { occupied: true, status: res.status, detail: await res.text().catch(() => '') };
  } catch {
    try {
      // Not PCC, but perhaps something else entirely. Any answer at all is a
      // reason to stop.
      const res = await fetch(new URL('/', baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
      return { occupied: true, status: res.status, detail: 'something non-PCC is answering' };
    } catch {
      return { occupied: false };
    }
  }
}

/**
 * Exit non-zero if anything is already answering. Call BEFORE starting the
 * container under test.
 *
 * Failing loudly here is the whole point: the alternative is a green test run
 * describing an application nobody deployed.
 */
export async function requireFreePort(baseUrl) {
  const found = await portIsOccupied(baseUrl);
  if (!found.occupied) return;
  console.error(`\nport-guard: something is ALREADY answering at ${baseUrl} (status ${found.status}).`);
  console.error('port-guard: refusing to run — a test that shares a port with another instance');
  console.error('            reports on whichever one answers, and it is usually the old one.');
  console.error('');
  console.error('            docker ps --format "{{.Names}}\\t{{.Ports}}"   # find it');
  console.error('            docker stop <name>                            # or pick another port');
  process.exit(1);
}

/**
 * Prove the instance answering is the one we started, by asking it for a fact
 * only that instance can know.
 *
 * `marker` is a value the caller put into this instance's environment — an
 * organization name, a bootstrap email. If the running application does not
 * report it, something else is on the port.
 */
export async function requireExpectedInstance(baseUrl, probe) {
  const seen = await probe();
  if (seen.ok) return;
  console.error(`\nport-guard: the application at ${baseUrl} is NOT the one this run started.`);
  console.error(`port-guard: ${seen.detail}`);
  console.error('port-guard: refusing to report a result about an instance nobody here deployed.');
  process.exit(1);
}
