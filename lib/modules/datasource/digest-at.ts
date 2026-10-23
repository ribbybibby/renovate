import { logger } from '../../logger/index.ts';
import type {
  LookupUpdateConfig,
  UpdateResult,
} from '../../workers/repository/process/lookup/types.ts';
import { getDatasourceFor } from './common.ts';
import type { DigestAt, Release } from './types.ts';

type Config = Partial<LookupUpdateConfig & UpdateResult>;

/**
 * Resolves what `release` pointed at on or before `before`, for datasources
 * whose registry republishes a reference in place.
 *
 * `null` when the datasource doesn't support it, or the reference has never
 * pointed at anything that old.
 */
export async function getDigestAt(
  config: Config,
  release: Release,
  before: number,
): Promise<DigestAt | null> {
  const { datasource } = config;

  const ds = datasource && getDatasourceFor(datasource);
  if (!ds || !ds.getDigestAt) {
    return null;
  }

  const { packageName } = config;
  if (!packageName) {
    return null;
  }

  // Same precedence as `postprocessRelease()`: prefer the registry that
  // actually reported this release.
  const registryUrl =
    release.registryUrl ??
    config.registryUrl ??
    config.registryUrls?.at(0) ??
    null;

  try {
    return await ds.getDigestAt(
      { packageName, registryUrl },
      release.versionOrig ?? release.version,
      before,
    );
  } catch (err) {
    logger.debug(
      { err, datasource, packageName, version: release.version },
      'Failed to resolve a digest for the minimumReleaseAge window',
    );
    return null;
  }
}
