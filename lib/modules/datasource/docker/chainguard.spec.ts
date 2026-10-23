import { hostRules } from '~test/host-rules.ts';
import * as httpMock from '~test/http-mock.ts';
import { Http } from '../../../util/http/index.ts';
import type { Timestamp } from '../../../util/timestamp.ts';
import {
  CHAINGUARD_API,
  chainguardTagsAsReleases,
  getChainguardTags,
  isChainguardEnabled,
  rewindChainguardTag,
} from './chainguard.ts';
import { CHAINGUARD_REGISTRY } from './common.ts';

const http = new Http('docker');

const groupId = 'aaaa';
const repoId = 'aaaa/bbbb';

/** The group + repo lookups every call starts with. */
function mockRepoLookup(
  scope: ReturnType<typeof httpMock.scope>,
  org = 'my-org',
  repo = 'python',
): ReturnType<typeof httpMock.scope> {
  return scope
    .get(`/iam/v1/groups?name=${org}`)
    .reply(200, { items: [{ id: groupId, name: org }] })
    .get(`/registry/v1/repos?uidp.childrenOf=${groupId}&name=${repo}`)
    .reply(200, { items: [{ id: repoId, name: repo }] });
}

const twoTags = {
  items: [
    {
      id: `${repoId}/1`,
      name: '3.13',
      digest: 'sha256:aaa',
      lastUpdated: '2026-06-10T20:18:06.420Z',
    },
    {
      id: `${repoId}/2`,
      name: '3.14',
      digest: 'sha256:bbb',
      lastUpdated: '2026-06-14T18:46:31.317Z',
    },
  ],
};

describe('modules/datasource/docker/chainguard', () => {
  describe('isChainguardEnabled', () => {
    beforeEach(() => {
      hostRules.clear();
    });

    it('is off without credentials for the platform API', () => {
      expect(isChainguardEnabled(CHAINGUARD_REGISTRY)).toBe(false);
    });

    it('is on with a token', () => {
      hostRules.add({ matchHost: 'console-api.enforce.dev', token: 'abc' });
      expect(isChainguardEnabled(CHAINGUARD_REGISTRY)).toBe(true);
    });

    it('is on with a username and password', () => {
      hostRules.add({
        matchHost: 'console-api.enforce.dev',
        username: 'u',
        password: 'p',
      });
      expect(isChainguardEnabled(CHAINGUARD_REGISTRY)).toBe(true);
    });

    it('is off for other registries even with credentials', () => {
      hostRules.add({ matchHost: 'console-api.enforce.dev', token: 'abc' });
      expect(isChainguardEnabled('https://index.docker.io')).toBe(false);
    });
  });

  describe('getChainguardTags', () => {
    it('returns the tags for a repository', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope)
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, twoTags);

      const res = await getChainguardTags(http, 'my-org/python');

      expect(res).toEqual([
        {
          id: `${repoId}/1`,
          name: '3.13',
          lastUpdated: '2026-06-10T20:18:06.420Z',
        },
        {
          id: `${repoId}/2`,
          name: '3.14',
          lastUpdated: '2026-06-14T18:46:31.317Z',
        },
      ]);
    });

    it('walks subgroups for a chart repository', async () => {
      const subgroupId = 'aaaa/cccc';
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [{ id: groupId, name: 'my-org' }] })
        .get(`/iam/v1/groups?uidp.childrenOf=${groupId}&name=charts`)
        .reply(200, { items: [{ id: subgroupId, name: 'charts' }] })
        .get(`/registry/v1/repos?uidp.childrenOf=${subgroupId}&name=nginx`)
        .reply(200, { items: [{ id: repoId, name: 'nginx' }] })
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, { items: [] });

      await expect(
        getChainguardTags(http, 'my-org/charts/nginx'),
      ).resolves.toEqual([]);
    });

    it('returns null for an unknown group', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [] });

      await expect(
        getChainguardTags(http, 'my-org/python'),
      ).resolves.toBeNull();
    });

    it('returns null for an unknown repository', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [{ id: groupId, name: 'my-org' }] })
        .get(`/registry/v1/repos?uidp.childrenOf=${groupId}&name=python`)
        .reply(200, { items: [] });

      await expect(
        getChainguardTags(http, 'my-org/python'),
      ).resolves.toBeNull();
    });

    it('returns null for an unknown subgroup', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [{ id: groupId, name: 'my-org' }] })
        .get(`/iam/v1/groups?uidp.childrenOf=${groupId}&name=charts`)
        .reply(200, { items: [] });

      await expect(
        getChainguardTags(http, 'my-org/charts/nginx'),
      ).resolves.toBeNull();
    });

    it('returns null when the package name has no group segment', async () => {
      await expect(getChainguardTags(http, 'python')).resolves.toBeNull();
    });

    it('throws when a group name is ambiguous', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, {
          items: [
            { id: 'aaaa', name: 'my-org' },
            { id: 'dddd', name: 'my-org' },
          ],
        });

      await expect(getChainguardTags(http, 'my-org/python')).rejects.toThrow(
        /matched 2 groups/,
      );
    });

    it('throws rather than reporting no tags when the payload is unreadable', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope)
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        // `items` renamed upstream: this must not look like an empty
        // repository, or the caller reports zero releases instead of
        // falling back to the registry API.
        .reply(200, { tags: [] });

      await expect(getChainguardTags(http, 'my-org/python')).rejects.toThrow(
        /invalid_type|Invalid input/,
      );
    });
  });

  describe('chainguardTagsAsReleases', () => {
    it('maps tags to releases, without digests', () => {
      expect(
        chainguardTagsAsReleases([
          {
            id: 'x',
            name: '3.14',
            lastUpdated: '2026-06-14T18:46:31.317Z' as Timestamp,
          },
          { id: 'y', name: 'edge', lastUpdated: null },
        ]),
      ).toEqual([
        { version: '3.14', releaseTimestamp: '2026-06-14T18:46:31.317Z' },
        { version: 'edge' },
      ]);
    });
  });

  describe('rewindChainguardTag', () => {
    const cutoff = Date.parse('2026-06-13T00:00:00.000Z');

    it('returns the newest digest at or before the cutoff', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope)
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, twoTags)
        .get(`/registry/v1/tags/${repoId}/2/history`)
        .reply(200, {
          items: [
            {
              digest: 'sha256:old',
              updateTimestamp: '2026-06-02T00:00:00.000Z',
            },
            {
              digest: 'sha256:settled',
              updateTimestamp: '2026-06-11T00:00:00.000Z',
            },
            {
              digest: 'sha256:fresh',
              updateTimestamp: '2026-06-19T23:00:00.000Z',
            },
          ],
        });

      await expect(
        rewindChainguardTag(http, 'my-org/python', '3.14', cutoff),
      ).resolves.toEqual({
        digest: 'sha256:settled',
        releaseTimestamp: '2026-06-11T00:00:00.000Z',
      });
    });

    it('ignores history entries which cannot be dated', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope)
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, twoTags)
        .get(`/registry/v1/tags/${repoId}/2/history`)
        .reply(200, {
          items: [
            { digest: 'sha256:undated', updateTimestamp: null },
            {
              digest: 'sha256:settled',
              updateTimestamp: '2026-06-11T00:00:00.000Z',
            },
          ],
        });

      await expect(
        rewindChainguardTag(http, 'my-org/python', '3.14', cutoff),
      ).resolves.toEqual({
        digest: 'sha256:settled',
        releaseTimestamp: '2026-06-11T00:00:00.000Z',
      });
    });

    it('returns null when nothing in history is old enough', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope)
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, twoTags)
        .get(`/registry/v1/tags/${repoId}/2/history`)
        .reply(200, {
          items: [
            {
              digest: 'sha256:brandnew',
              updateTimestamp: '2026-06-18T00:00:00.000Z',
            },
          ],
        });

      await expect(
        rewindChainguardTag(http, 'my-org/python', '3.14', cutoff),
      ).resolves.toBeNull();
    });

    it('returns null for a tag the repository does not have', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope)
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, twoTags);

      await expect(
        rewindChainguardTag(http, 'my-org/python', '9.99', cutoff),
      ).resolves.toBeNull();
    });
  });
});
