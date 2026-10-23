import { logger } from '../../../logger/index.ts';
import * as hostRules from '../../../util/host-rules.ts';
import { memCacheProvider } from '../../../util/http/cache/memory-http-cache-provider.ts';
import type { Http } from '../../../util/http/index.ts';
import type { Release } from '../types.ts';
import { CHAINGUARD_REGISTRY, dockerDatasourceId } from './common.ts';
import {
  ChainguardGroupList,
  ChainguardRepoList,
  ChainguardTagHistory,
  ChainguardTagList,
} from './schema.ts';
import type { ChainguardTag, RewoundTag } from './types.ts';

/**
 * Chainguard's control plane. Tags and tag history come from here rather than
 * from `cgr.dev` itself, because neither is expressible in the OCI
 * distribution API.
 */
export const CHAINGUARD_API = 'https://console-api.enforce.dev';

/**
 * Responses are memoised for the run: `getReleases()` and every subsequent
 * `postprocessRelease()`/`getDigest()` call for the same repository resolve
 * the same group, repo and tag list.
 */
const httpOptions = { cacheProvider: memCacheProvider };

/** Thrown when the platform API returns something we can't read. */
export class ChainguardApiError extends Error {}

/**
 * Whether to resolve this registry through the Chainguard platform API.
 *
 * Gated on credentials rather than a feature flag: the platform API answers
 * 401 to anonymous callers, so without this every lookup of a public
 * `cgr.dev/chainguard/*` image would make a request that cannot succeed.
 */
export function isChainguardEnabled(registryHost: string): boolean {
  if (registryHost !== CHAINGUARD_REGISTRY) {
    return false;
  }
  const { token, username, password } = hostRules.find({
    hostType: dockerDatasourceId,
    url: CHAINGUARD_API,
  });
  return !!token || !!(username && password);
}

/**
 * Resolve `<group>/<subgroup...>/<repo>` to the repository's UIDP.
 *
 * The first segment of a `cgr.dev` path is the Chainguard group, the last is
 * the repository, and anything between the two is a subgroup — which is how
 * chart repositories such as `charts/nginx` are laid out. Each level needs its
 * own lookup because a UIDP is opaque and can't be derived from the name.
 *
 * Returns `null` when any level is genuinely absent, as opposed to throwing,
 * which signals that the API could not be read.
 */
async function resolveRepoId(
  http: Http,
  dockerRepository: string,
): Promise<string | null> {
  const segments = dockerRepository.split('/');
  if (segments.length < 2) {
    logger.debug(`Chainguard: no group segment in ${dockerRepository}`);
    return null;
  }

  const [groupName, ...rest] = segments;
  const repoName = rest.pop()!;

  const groups = await http.getJson(
    `${CHAINGUARD_API}/iam/v1/groups?name=${encodeURIComponent(groupName)}`,
    httpOptions,
    ChainguardGroupList,
  );
  // The root lookup can't be scoped by parent, so an ambiguous name could
  // otherwise resolve to a same-named group in an unrelated org.
  if (groups.body.items.length > 1) {
    throw new ChainguardApiError(
      `Chainguard: group name ${groupName} matched ${groups.body.items.length} groups`,
    );
  }
  let parentId = groups.body.items[0]?.id;
  if (!parentId) {
    logger.debug(`Chainguard: group ${groupName} not found`);
    return null;
  }

  for (const subgroup of rest) {
    const subgroups = await http.getJson(
      `${CHAINGUARD_API}/iam/v1/groups?uidp.childrenOf=${parentId}&name=${encodeURIComponent(subgroup)}`,
      httpOptions,
      ChainguardGroupList,
    );
    const id = subgroups.body.items[0]?.id;
    if (!id) {
      logger.debug(
        `Chainguard: subgroup ${subgroup} of ${dockerRepository} not found`,
      );
      return null;
    }
    parentId = id;
  }

  const repos = await http.getJson(
    `${CHAINGUARD_API}/registry/v1/repos?uidp.childrenOf=${parentId}&name=${encodeURIComponent(repoName)}`,
    httpOptions,
    ChainguardRepoList,
  );
  const repoId = repos.body.items[0]?.id;
  if (!repoId) {
    logger.debug(`Chainguard: repository ${dockerRepository} not found`);
    return null;
  }
  return repoId;
}

/**
 * Current state of every tag in the repository, or `null` if the repository
 * isn't visible to the configured credentials.
 */
export async function getChainguardTags(
  http: Http,
  dockerRepository: string,
): Promise<ChainguardTag[] | null> {
  const repoId = await resolveRepoId(http, dockerRepository);
  if (!repoId) {
    return null;
  }
  const res = await http.getJson(
    // Referrer tags (`sha256-*.sig`, `.att`, …) aren't updatable versions.
    `${CHAINGUARD_API}/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
    httpOptions,
    ChainguardTagList,
  );
  return res.body.items;
}

/** Tags as releases, carrying the timestamp the tag last moved. */
export function chainguardTagsAsReleases(tags: ChainguardTag[]): Release[] {
  return tags.map((tag) => {
    const release: Release = { version: tag.name };
    if (tag.lastUpdated) {
      release.releaseTimestamp = tag.lastUpdated;
    }
    // Digest is intentionally not propagated: it's the image index digest,
    // which would bypass arch-aware resolution in `getDigest()`.
    return release;
  });
}

/**
 * The digest `tagName` pointed at when `cutoff` passed, and when it was pushed.
 *
 * Chainguard rebuilds every supported tag whenever one of its packages
 * changes, so a tag's current digest is almost always newer than a
 * `minimumReleaseAge` window. Rewinding lets an update be proposed at a digest
 * that has been published long enough to satisfy the policy, instead of the
 * tag being withheld until it stops being rebuilt.
 *
 * `null` means the tag has never pointed at anything old enough, so there is
 * nothing to update to yet.
 */
export async function rewindChainguardTag(
  http: Http,
  dockerRepository: string,
  tagName: string,
  cutoff: number,
): Promise<RewoundTag | null> {
  const tags = await getChainguardTags(http, dockerRepository);
  const tag = tags?.find((t) => t.name === tagName);
  if (!tag) {
    return null;
  }

  // `TagHistoryFilter` also accepts an `end` bound, which would trim the
  // response server-side; left off until it's been verified against the REST
  // gateway, since the filtering below is what decides the answer either way.
  const res = await http.getJson(
    `${CHAINGUARD_API}/registry/v1/tags/${tag.id}/history`,
    httpOptions,
    ChainguardTagHistory,
  );

  let best: RewoundTag | null = null;
  for (const entry of res.body.items) {
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
