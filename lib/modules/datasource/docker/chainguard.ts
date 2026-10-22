import { logger } from '../../../logger/index.ts';
import type { Http } from '../../../util/http/index.ts';
import * as p from '../../../util/promises.ts';
import type { Timestamp } from '../../../util/timestamp.ts';
import { asTimestamp } from '../../../util/timestamp.ts';
import type { Release } from '../types.ts';
import {
  ChainguardGroupList,
  ChainguardRepoList,
  ChainguardTagHistory,
  ChainguardTagList,
} from './schema.ts';
import type { ChainguardReleasesOptions } from './types.ts';

export const CHAINGUARD_REGISTRY = 'https://cgr.dev';

/**
 * Chainguard's control plane. Tags and tag history come from here rather than
 * from `cgr.dev` itself, because neither is expressible in the OCI
 * distribution API.
 */
export const CHAINGUARD_API = 'https://console-api.enforce.dev';

/** Cap on concurrent tag-history lookups for a single repository. */
const historyConcurrency = 16;

interface ChainguardTag {
  id: string;
  name: string;
  digest: string | null;
  lastUpdated: Timestamp | null;
}

/**
 * Resolve `<group>/<subgroup...>/<repo>` to the repository's UIDP.
 *
 * The first segment of a `cgr.dev` path is the Chainguard group, the last is
 * the repository, and anything between the two is a subgroup — which is how
 * chart repositories such as `charts/nginx` are laid out. Each level needs its
 * own lookup because a UIDP is opaque and can't be derived from the name.
 */
async function resolveRepoId(
  http: Http,
  apiUrl: string,
  dockerRepository: string,
): Promise<string | null> {
  const segments = dockerRepository.split('/');
  if (segments.length < 2) {
    logger.debug(
      { dockerRepository },
      'Chainguard: repository path has no group segment',
    );
    return null;
  }

  const [groupName, ...rest] = segments;
  const repoName = rest.pop()!;

  const groups = await http.getJson(
    `${apiUrl}/iam/v1/groups?name=${encodeURIComponent(groupName)}`,
    ChainguardGroupList,
  );
  let parentId = groups.body.items[0]?.id;
  if (!parentId) {
    logger.debug({ groupName }, 'Chainguard: group not found');
    return null;
  }

  for (const subgroup of rest) {
    const subgroups = await http.getJson(
      `${apiUrl}/iam/v1/groups?uidp.childrenOf=${parentId}&name=${encodeURIComponent(subgroup)}`,
      ChainguardGroupList,
    );
    const id = subgroups.body.items[0]?.id;
    if (!id) {
      logger.debug(
        { dockerRepository, subgroup },
        'Chainguard: subgroup not found',
      );
      return null;
    }
    parentId = id;
  }

  const repos = await http.getJson(
    `${apiUrl}/registry/v1/repos?uidp.childrenOf=${parentId}&name=${encodeURIComponent(repoName)}`,
    ChainguardRepoList,
  );
  const repoId = repos.body.items[0]?.id;
  if (!repoId) {
    logger.debug({ dockerRepository }, 'Chainguard: repository not found');
    return null;
  }
  return repoId;
}

async function listTags(
  http: Http,
  apiUrl: string,
  repoId: string,
): Promise<ChainguardTag[]> {
  const res = await http.getJson(
    `${apiUrl}/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
    ChainguardTagList,
  );
  return res.body.items.map(({ id, name, digest, lastUpdated }) => ({
    id,
    name,
    digest,
    lastUpdated: asTimestamp(lastUpdated),
  }));
}

interface RewoundTag {
  digest: string;
  releaseTimestamp: Timestamp;
}

/**
 * The digest a tag pointed at when `cutoff` passed, with the timestamp of the
 * push that put it there, or `null` if the tag didn't exist yet.
 */
async function rewindTag(
  http: Http,
  apiUrl: string,
  tag: ChainguardTag,
  cutoff: number,
): Promise<RewoundTag | null> {
  const res = await http.getJson(
    `${apiUrl}/registry/v1/tags/${tag.id}/history`,
    ChainguardTagHistory,
  );

  let best: RewoundTag | null = null;
  for (const entry of res.body.items) {
    const releaseTimestamp = asTimestamp(entry.updateTimestamp);
    // Drop undatable entries: we can't prove they sit outside the window.
    if (!releaseTimestamp) {
      continue;
    }
    const ms = Date.parse(releaseTimestamp);
    if (ms > cutoff) {
      continue;
    }
    if (best === null || ms > Date.parse(best.releaseTimestamp)) {
      best = { digest: entry.digest, releaseTimestamp };
    }
  }
  return best;
}

/**
 * Tags for a `cgr.dev` repository, as releases carrying a `releaseTimestamp`.
 *
 * Chainguard rebuilds every supported tag whenever one of its packages
 * changes, so a tag's current digest is almost always newer than a
 * `minimumReleaseAge` window — taking `lastUpdated` at face value would hold
 * every update indefinitely. When a window is configured, a tag that is too
 * fresh is instead rewound to the digest it pointed at when the window opened,
 * so the update Renovate proposes is one that has been published long enough
 * to satisfy the policy.
 *
 * A rewound release carries its historical digest as `newDigest`, because
 * `getDigest()` can only ever resolve the tag's current digest. That digest is
 * the one the tag pointed at, so for a multi-arch repository it is the image
 * index rather than an architecture-specific manifest.
 */
export async function getChainguardReleases(
  http: Http,
  dockerRepository: string,
  opts: ChainguardReleasesOptions = {},
): Promise<Release[] | null> {
  const apiUrl = opts.apiUrl ?? CHAINGUARD_API;
  const minimumReleaseAgeMs = opts.minimumReleaseAgeMs ?? 0;

  const repoId = await resolveRepoId(http, apiUrl, dockerRepository);
  if (!repoId) {
    return null;
  }

  const tags = await listTags(http, apiUrl, repoId);

  if (!minimumReleaseAgeMs) {
    return tags.map((tag) => {
      const release: Release = { version: tag.name };
      if (tag.lastUpdated) {
        release.releaseTimestamp = tag.lastUpdated;
      }
      // Digest is intentionally not propagated here: it's the image index
      // digest, which would bypass arch-aware resolution in `getDigest()`.
      return release;
    });
  }

  const cutoff = Date.now() - minimumReleaseAgeMs;

  // Indexed by tag so the result keeps the order the API returned, whichever
  // tags needed a history walk.
  const slots: (Release | null)[] = tags.map(() => null);
  const fresh: number[] = [];

  tags.forEach((tag, i) => {
    if (!tag.lastUpdated) {
      // Without a timestamp we can't show the tag satisfies the window.
      return;
    }
    if (Date.parse(tag.lastUpdated) <= cutoff) {
      slots[i] = { version: tag.name, releaseTimestamp: tag.lastUpdated };
      return;
    }
    fresh.push(i);
  });

  await p.map(
    fresh,
    async (i) => {
      const tag = tags[i];
      const entry = await rewindTag(http, apiUrl, tag, cutoff);
      if (!entry) {
        // The tag is newer than the window all the way back to its first
        // push, so there is nothing old enough to update to yet.
        return;
      }
      slots[i] = {
        version: tag.name,
        releaseTimestamp: entry.releaseTimestamp,
        newDigest: entry.digest,
      };
    },
    { concurrency: historyConcurrency },
  );

  return slots.filter((release) => release !== null);
}
