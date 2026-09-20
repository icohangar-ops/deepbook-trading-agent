/**
 * VENDORED COPY — keep in sync with the canonical package.
 *
 * Vendored from @cubiczan/resilience (icohangar-ops/cubiczan-resilience,
 * typescript/src) at typescript-v0.2.0
 * (commit 37ce1571f5beb751d153ecdc3b1457cd9c871e37).
 * Check the canonical package for updates before modifying locally; this
 * copy's scope and intentional local deltas are recorded in VENDOR_COMMIT.txt
 * beside this file.
 */

/**
 * Vendored resilience primitives.
 *
 * Copied verbatim from cubiczan-resilience (typescript/src) because there is no
 * private npm registry to depend on. Source files: errors.ts, retry.ts,
 * timeout.ts, safeFetch.ts. Do not edit by hand — re-vendor from upstream if
 * the shared library changes.
 */
export { safeFetch } from './safeFetch.js';
export type { SafeFetchOptions, AllowlistHook } from './safeFetch.js';
export { retry, computeBackoff } from './retry.js';
export type { RetryOptions } from './retry.js';
export { withTimeout } from './timeout.js';
export { ResilienceError, isResilienceError } from './errors.js';
export type { ResilienceErrorKind, ResilienceErrorOptions } from './errors.js';
