import type { LookupUpdateConfig } from './types.ts';

/**
 * Whether a resolved digest will be written to the package file.
 *
 * Shared with `filterInternalChecks()` so the two can't drift: without a
 * written digest the reference stays mutable, and an age reported for an
 * older digest would describe something the user never pulls.
 */
export function willWriteDigest(
  config: Pick<
    LookupUpdateConfig,
    'pinDigests' | 'digestManagedExternally' | 'currentDigest'
  >,
): boolean {
  return (
    (config.pinDigests === true && !config.digestManagedExternally) ||
    !!config.currentDigest
  );
}
