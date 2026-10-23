import * as httpMock from '~test/http-mock.ts';
import { Http } from '../../../util/http/index.ts';
import type { Timestamp } from '../../../util/timestamp.ts';
import { getChainguardTagHistory, rewindTagHistory } from './chainguard.ts';
import { CHAINGUARD_REGISTRY } from './common.ts';

const http = new Http('docker');

function ts(value: string): Timestamp {
  return value as Timestamp;
}

describe('modules/datasource/docker/chainguard', () => {
  describe('getChainguardTagHistory', () => {
    it('returns the history for a tag', async () => {
      httpMock
        .scope(CHAINGUARD_REGISTRY)
        .get('/v2/')
        .reply(200, '', {})
        .get('/v2/my-org/python/_chainguard/history/3.14')
        .reply(200, {
          history: [
            {
              digest: 'sha256:old',
              updateTimestamp: '2026-06-02T00:00:00.000Z',
            },
            {
              digest: 'sha256:fresh',
              updateTimestamp: '2026-06-19T23:00:00.000Z',
            },
          ],
        });

      const res = await getChainguardTagHistory(
        http,
        CHAINGUARD_REGISTRY,
        'my-org/python',
        '3.14',
      );

      expect(res).toEqual([
        { digest: 'sha256:old', updateTimestamp: '2026-06-02T00:00:00.000Z' },
        {
          digest: 'sha256:fresh',
          updateTimestamp: '2026-06-19T23:00:00.000Z',
        },
      ]);
    });

    it('returns null when the registry refuses auth', async () => {
      httpMock.scope(CHAINGUARD_REGISTRY).get('/v2/').reply(401, '', {});

      await expect(
        getChainguardTagHistory(
          http,
          CHAINGUARD_REGISTRY,
          'my-org/python',
          '3.14',
        ),
      ).resolves.toBeNull();
    });

    it('returns null when the registry has no history for the tag', async () => {
      httpMock
        .scope(CHAINGUARD_REGISTRY)
        .get('/v2/')
        .reply(200, '', {})
        .get('/v2/my-org/python/_chainguard/history/3.14')
        .reply(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });

      await expect(
        getChainguardTagHistory(
          http,
          CHAINGUARD_REGISTRY,
          'my-org/python',
          '3.14',
        ),
      ).resolves.toBeNull();
    });

    it('rethrows other registry errors', async () => {
      httpMock
        .scope(CHAINGUARD_REGISTRY)
        .get('/v2/')
        .reply(200, '', {})
        .get('/v2/my-org/python/_chainguard/history/3.14')
        .reply(500);

      await expect(
        getChainguardTagHistory(
          http,
          CHAINGUARD_REGISTRY,
          'my-org/python',
          '3.14',
        ),
      ).rejects.toThrow(/status code 500/);
    });

    it('throws rather than reporting no history when the payload is unreadable', async () => {
      httpMock
        .scope(CHAINGUARD_REGISTRY)
        .get('/v2/')
        .reply(200, '', {})
        .get('/v2/my-org/python/_chainguard/history/3.14')
        // `history` renamed upstream: this must not look like a tag with no
        // history, or the caller would silently stop rewinding.
        .reply(200, { items: [] });

      await expect(
        getChainguardTagHistory(
          http,
          CHAINGUARD_REGISTRY,
          'my-org/python',
          '3.14',
        ),
      ).rejects.toThrow(/invalid_type|Invalid input/);
    });
  });

  describe('rewindTagHistory', () => {
    const cutoff = Date.parse('2026-06-13T00:00:00.000Z');

    it('returns the newest entry at or before the cutoff', () => {
      expect(
        rewindTagHistory(
          [
            {
              digest: 'sha256:old',
              updateTimestamp: ts('2026-06-02T00:00:00.000Z'),
            },
            {
              digest: 'sha256:settled',
              updateTimestamp: ts('2026-06-11T00:00:00.000Z'),
            },
            {
              digest: 'sha256:fresh',
              updateTimestamp: ts('2026-06-19T23:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toEqual({
        digest: 'sha256:settled',
        releaseTimestamp: '2026-06-11T00:00:00.000Z',
      });
    });

    it('treats the cutoff as inclusive', () => {
      expect(
        rewindTagHistory(
          [
            {
              digest: 'sha256:exact',
              updateTimestamp: ts('2026-06-13T00:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toEqual({
        digest: 'sha256:exact',
        releaseTimestamp: '2026-06-13T00:00:00.000Z',
      });
    });

    it('ignores entries which cannot be dated', () => {
      expect(
        rewindTagHistory(
          [
            { digest: 'sha256:undated', updateTimestamp: null },
            {
              digest: 'sha256:settled',
              updateTimestamp: ts('2026-06-11T00:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toEqual({
        digest: 'sha256:settled',
        releaseTimestamp: '2026-06-11T00:00:00.000Z',
      });
    });

    it('returns null when nothing is old enough', () => {
      expect(
        rewindTagHistory(
          [
            {
              digest: 'sha256:brandnew',
              updateTimestamp: ts('2026-06-18T00:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toBeNull();
    });
  });
});
