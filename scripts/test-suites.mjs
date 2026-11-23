/**
 * The offline test suite, in the one order every runner uses.
 *
 * `npm test` (scripts/run-tests.mjs), the host matrix, and the coverage runner
 * all import this list, so a new test file cannot be added to one path and
 * forgotten by the others.
 */
export const OFFLINE_TESTS = [
  'test/suite-manifest.mjs',
  'test/import-surface.mjs',
  'test/config.mjs',
  'test/config-runtime.mjs',
  'test/client-bundle.mjs',
  'test/manifest.mjs',
  'test/plugin.mjs',
  'test/plugin-live.mjs',
  'test/status.mjs',
  'test/web-status.mjs',
  'test/wire.mjs',
  'test/errors.mjs',
  'test/credentials.mjs',
  'test/credentials-platform.mjs',
  'test/catalog.mjs',
  'test/catalog-fetch.mjs',
  'test/adapter-meta.mjs',
  'test/adapter-finish.mjs',
  'test/adapter-contract.mjs',
  'test/security.mjs',
  'test/adapter-usage.mjs',
  'test/adapter-auth.mjs',
  'test/adapter-image.mjs',
]

/** The one live suite; never part of `npm test`. */
export const LIVE_TEST = 'e2e.mjs'
