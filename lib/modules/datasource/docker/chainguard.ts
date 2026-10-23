import { logger } from '../../../logger/index.ts';
import { memCacheProvider } from '../../../util/http/cache/memory-http-cache-provider.ts';
import type { Http } from '../../../util/http/index.ts';
import type { Timestamp } from '../../../util/timestamp.ts';
import type { HistoricDigest } from '../types.ts';
import { getAuthHeaders } from './common.ts';
import { ChainguardTagHistory } from './schema.ts';
import type { ChainguardTagHistoryEntry } from './types.ts';

/** Every digest a tag pointed at on or before `end`, or `null` if unknown. */
export async function getChainguardTagHistory(
  http: Http,
  registryHost: string,
  dockerRepository: string,
  tag: string,
  end: Timestamp,
): Promise<ChainguardTagHistoryEntry[] | null> {
  const headers = await getAuthHeaders(http, registryHost, dockerRepository);
  if (!headers) {
    logger.debug(
      `Chainguard: no auth headers for ${dockerRepository}, skipping tag history`,
    );
    return null;
  }

  // The response is paginated. Bounded by `end` it comes back newest-first,
  // so a truncated page drops the oldest entries; unbounded it is
  // oldest-first, where truncation would hide the newest and make a tag that
  // is still being rebuilt look settled.
  const url = `${registryHost}/v2/${dockerRepository}/_chainguard/history/${tag}?end=${encodeURIComponent(end)}`;

  try {
    const res = await http.getJson(
      url,
      { headers, noAuth: true, cacheProvider: memCacheProvider },
      ChainguardTagHistory,
    );
    return res.body.history;
  } catch (err) {
    // Anything else, including ExternalHostError, is for the caller to
    // decide on.
    if (err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * The newest entry at or before `cutoff`.
 *
 * Scans rather than indexing: ordering depends on how the endpoint was
 * queried, and a dropped entry would shift a fixed position.
 */
export function newestEntryAtOrBefore(
  history: ChainguardTagHistoryEntry[],
  cutoff: number,
): HistoricDigest | null {
  let best: HistoricDigest | null = null;
  for (const entry of history) {
    // Drop undatable entries: we can't prove they sit outside the window.
    if (!entry.updateTimestamp) {
      continue;
    }
    const ms = Date.parse(entry.updateTimestamp);
    if (ms > cutoff) {
      continue;
    }
    if (best === null || ms > Date.parse(best.releaseTimestamp)) {
      best = { digest: entry.digest, releaseTimestamp: entry.updateTimestamp };
    }
  }
  return best;
}
