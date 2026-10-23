import type { LookupUpdateConfig } from './types.ts';

/**
 * Whether a digest Renovate resolves will actually be written to the package
 * file.
 *
 * Lives on its own so that `resolveUpdateDigests()` and the datasource layer
 * can't drift: a datasource which reports a digest-specific
 * `releaseTimestamp` is only telling the truth when the digest lands too.
 * Without a digest the reference stays mutable, and what gets pulled is
 * whatever the tag resolves to at the time.
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
