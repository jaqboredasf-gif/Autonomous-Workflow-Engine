import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* No rewrites, no remote images, no external services. */

  /**
   * STANDALONE, so the runtime image can be the application and its traced
   * dependencies and nothing else — no repository, no toolchain, no compiler,
   * no test suites. `outputFileTracingRoot` points at the monorepo root
   * because `@awe/workflow` is a workspace package: without it the tracer
   * starts at apps/purchasing, misses the sibling package, and produces a
   * server that dies on its first import.
   */
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

};

/**
 * NEVER SHIP A DATABASE — and note that this file cannot be where that is
 * enforced. The standalone copier walks the application directory and copies
 * `.data/purchasing.db` with it, so a plain `npm run build` on a developer
 * machine produces a deployable artifact with a real pilot database inside it.
 * Deployed, that is the database the application opens: the developer's
 * records become the company's, and the next redeploy replaces them again.
 *
 * `outputFileTracingExcludes` does not prevent it (it governs the dependency
 * TRACE, not the app-directory copy), so the two controls that do are both
 * outside this file:
 *
 *   .dockerignore                   the image build never sees the file
 *   scripts/check-deployable.mjs    the package is scanned and the build fails
 *
 * The second one runs from `postbuild`, so it is part of `npm run build` on
 * EVERY path rather than a step somebody remembers. It used to run only in the
 * Dockerfile, which left the Docker deployment gated and the plain Node one —
 * the systemd unit in deploy/pcc-node.service, the path for a VM without a
 * container runtime — resting on a line in a comment that a person could skip
 * at 6pm. The check that catches this is worth nothing on the path that
 * bypasses it.
 *
 * A comment claiming a setting works when it does not is worse than no
 * setting, which is why there isn't one here.
 */

export default nextConfig;
