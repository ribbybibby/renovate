import { logger } from '../../../logger/index.ts';
import { memCacheProvider } from '../../../util/http/cache/memory-http-cache-provider.ts';
import type { Http } from '../../../util/http/index.ts';
import { getAuthHeaders } from './common.ts';
import { ChainguardTagHistory } from './schema.ts';
import type { ChainguardTagHistoryEntry } from './types.ts';

/**
 * Chainguard's OCI extension, advertised at `/v2/_oci/ext/discover`.
 *
 * A tag's history is the one thing the distribution API can't express, and
 * it's what lets `minimumReleaseAge` work here: Chainguard rebuilds every
 * supported tag whenever one of its packages changes, so the digest a tag
 * points at is nearly always newer than the window.
 */
function historyUrl(
  registryHost: string,
  dockerRepository: string,
  tag: string,
): string {
  return `${registryHost}/v2/${dockerRepository}/_chainguard/history/${tag}`;
}

/**
 * Every digest a tag has pointed at, oldest first; the last entry is where it
 * points now. `null` when the registry has no history for the tag, which also
 * covers a registry that doesn't serve the extension at all.
 */
export async function getChainguardTagHistory(
  http: Http,
  registryHost: string,
  dockerRepository: string,
  tag: string,
): Promise<ChainguardTagHistoryEntry[] | null> {
  const url = historyUrl(registryHost, dockerRepository, tag);
  const headers = await getAuthHeaders(http, registryHost, dockerRepository);
  if (!headers) {
    logger.debug(
      `Chainguard: no auth headers for ${dockerRepository}, skipping tag history`,
    );
    return null;
  }

  try {
    const res = await http.getJson(
      url,
      { headers, noAuth: true, cacheProvider: memCacheProvider },
      ChainguardTagHistory,
    );
    return res.body.history;
  } catch (err) {
    if (err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * The newest entry at or before `cutoff`.
 *
 * `null` means the tag has never pointed at anything old enough, so there is
 * nothing that satisfies the window to update to yet.
 */
export function rewindTagHistory(
  history: ChainguardTagHistoryEntry[],
  cutoff: number,
): ChainguardTagHistoryEntry | null {
  let best: ChainguardTagHistoryEntry | null = null;
  for (const entry of history) {
    // Drop undatable entries: we can't prove they sit outside the window.
    if (!entry.updateTimestamp) {
      continue;
    }
    const ms = Date.parse(entry.updateTimestamp);
    if (ms > cutoff) {
      continue;
    }
    if (best === null || ms > Date.parse(best.updateTimestamp!)) {
      best = entry;
    }
  }
  return best;
}
