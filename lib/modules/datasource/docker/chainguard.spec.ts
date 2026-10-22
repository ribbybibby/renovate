import * as httpMock from '~test/http-mock.ts';
import { Http } from '../../../util/http/index.ts';
import { CHAINGUARD_API, getChainguardReleases } from './chainguard.ts';

const http = new Http('docker');

const groupId = 'aaaa';
const repoId = 'aaaa/bbbb';

/** Shorthand for the group + repo lookups every call starts with. */
function mockRepoLookup(
  scope: ReturnType<typeof httpMock.scope>,
  org = 'my-org',
  repo = 'python',
): void {
  scope
    .get(`/iam/v1/groups?name=${org}`)
    .reply(200, { items: [{ id: groupId, name: org }] })
    .get(`/registry/v1/repos?uidp.childrenOf=${groupId}&name=${repo}`)
    .reply(200, { items: [{ id: repoId, name: repo }] });
}

describe('modules/datasource/docker/chainguard', () => {
  describe('getChainguardReleases', () => {
    it('returns tags with release timestamps', async () => {
      const scope = httpMock.scope(CHAINGUARD_API);
      mockRepoLookup(scope);
      scope
        .get(
          `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
        )
        .reply(200, {
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
        });

      const res = await getChainguardReleases(http, 'my-org/python');

      // No digest without a window: it's the index digest, and `getDigest()`
      // resolves the tag arch-aware instead.
      expect(res).toEqual([
        { version: '3.13', releaseTimestamp: '2026-06-10T20:18:06.420Z' },
        { version: '3.14', releaseTimestamp: '2026-06-14T18:46:31.317Z' },
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
        .reply(200, {
          items: [
            {
              id: `${repoId}/1`,
              name: '1.2.3',
              digest: 'sha256:aaa',
              lastUpdated: '2026-06-10T20:18:06.420Z',
            },
          ],
        });

      const res = await getChainguardReleases(http, 'my-org/charts/nginx');

      expect(res).toEqual([
        { version: '1.2.3', releaseTimestamp: '2026-06-10T20:18:06.420Z' },
      ]);
    });

    it('returns null for an unknown group', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [] });

      const res = await getChainguardReleases(http, 'my-org/python');

      expect(res).toBeNull();
    });

    it('returns null for an unknown subgroup', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [{ id: groupId, name: 'my-org' }] })
        .get(`/iam/v1/groups?uidp.childrenOf=${groupId}&name=charts`)
        .reply(200, { items: [] });

      const res = await getChainguardReleases(http, 'my-org/charts/nginx');

      expect(res).toBeNull();
    });

    it('returns null for an unknown repository', async () => {
      httpMock
        .scope(CHAINGUARD_API)
        .get('/iam/v1/groups?name=my-org')
        .reply(200, { items: [{ id: groupId, name: 'my-org' }] })
        .get(`/registry/v1/repos?uidp.childrenOf=${groupId}&name=python`)
        .reply(200, { items: [] });

      const res = await getChainguardReleases(http, 'my-org/python');

      expect(res).toBeNull();
    });

    it('returns null when the package name has no group segment', async () => {
      const res = await getChainguardReleases(http, 'python');

      expect(res).toBeNull();
    });

    describe('with a minimumReleaseAge window', () => {
      const minimumReleaseAgeMs = 7 * 24 * 60 * 60 * 1000;

      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-06-20T00:00:00.000Z');
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('rewinds a tag that is newer than the window', async () => {
        const scope = httpMock.scope(CHAINGUARD_API);
        mockRepoLookup(scope);
        scope
          .get(
            `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
          )
          .reply(200, {
            items: [
              // Settled: older than the cutoff, emitted untouched.
              {
                id: `${repoId}/1`,
                name: '3.13',
                digest: 'sha256:aaa',
                lastUpdated: '2026-06-01T00:00:00.000Z',
              },
              // Rebuilt an hour ago: has to be rewound.
              {
                id: `${repoId}/2`,
                name: '3.14',
                digest: 'sha256:fresh',
                lastUpdated: '2026-06-19T23:00:00.000Z',
              },
            ],
          })
          .get(`/registry/v1/tags/${repoId}/2/history`)
          .reply(200, {
            items: [
              {
                digest: 'sha256:old',
                updateTimestamp: '2026-06-02T00:00:00.000Z',
              },
              // The newest entry at or before the 2026-06-13 cutoff.
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

        const res = await getChainguardReleases(http, 'my-org/python', {
          minimumReleaseAgeMs,
        });

        expect(res).toEqual([
          { version: '3.13', releaseTimestamp: '2026-06-01T00:00:00.000Z' },
          {
            version: '3.14',
            releaseTimestamp: '2026-06-11T00:00:00.000Z',
            newDigest: 'sha256:settled',
          },
        ]);
      });

      it('drops a tag with no history old enough to satisfy the window', async () => {
        const scope = httpMock.scope(CHAINGUARD_API);
        mockRepoLookup(scope);
        scope
          .get(
            `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
          )
          .reply(200, {
            items: [
              {
                id: `${repoId}/1`,
                name: '3.15',
                digest: 'sha256:brandnew',
                lastUpdated: '2026-06-19T23:00:00.000Z',
              },
            ],
          })
          .get(`/registry/v1/tags/${repoId}/1/history`)
          .reply(200, {
            items: [
              {
                digest: 'sha256:brandnew',
                updateTimestamp: '2026-06-18T00:00:00.000Z',
              },
            ],
          });

        const res = await getChainguardReleases(http, 'my-org/python', {
          minimumReleaseAgeMs,
        });

        expect(res).toEqual([]);
      });

      it('drops history entries which cannot be dated', async () => {
        const scope = httpMock.scope(CHAINGUARD_API);
        mockRepoLookup(scope);
        scope
          .get(
            `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
          )
          .reply(200, {
            items: [
              {
                id: `${repoId}/1`,
                name: '3.14',
                digest: 'sha256:fresh',
                lastUpdated: '2026-06-19T23:00:00.000Z',
              },
            ],
          })
          .get(`/registry/v1/tags/${repoId}/1/history`)
          .reply(200, {
            items: [
              { digest: 'sha256:undated', updateTimestamp: null },
              {
                digest: 'sha256:settled',
                updateTimestamp: '2026-06-11T00:00:00.000Z',
              },
            ],
          });

        const res = await getChainguardReleases(http, 'my-org/python', {
          minimumReleaseAgeMs,
        });

        expect(res).toEqual([
          {
            version: '3.14',
            releaseTimestamp: '2026-06-11T00:00:00.000Z',
            newDigest: 'sha256:settled',
          },
        ]);
      });

      it('drops a tag which cannot be dated', async () => {
        const scope = httpMock.scope(CHAINGUARD_API);
        mockRepoLookup(scope);
        scope
          .get(
            `/registry/v1/tags?uidp.childrenOf=${repoId}&excludeReferrers=true`,
          )
          .reply(200, {
            items: [
              {
                id: `${repoId}/1`,
                name: '3.14',
                digest: 'sha256:aaa',
                lastUpdated: null,
              },
            ],
          });

        const res = await getChainguardReleases(http, 'my-org/python', {
          minimumReleaseAgeMs,
        });

        expect(res).toEqual([]);
      });
    });
  });
});
