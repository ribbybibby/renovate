import * as httpMock from '~test/http-mock.ts';
import { Http } from '../../../util/http/index.ts';
import type { Timestamp } from '../../../util/timestamp.ts';
import {
  getChainguardTagHistory,
  newestEntryAtOrBefore,
} from './chainguard.ts';
import { CHAINGUARD_REGISTRY } from './common.ts';

const http = new Http('docker');
const end = '2026-06-20T00:00:00.000Z' as Timestamp;

function ts(value: string): Timestamp {
  return value as Timestamp;
}

function scope() {
  return httpMock
    .scope(CHAINGUARD_REGISTRY)
    .get('/v2/')
    .reply(200, '', {})
    .get('/v2/my-org/python/_chainguard/history/3.14')
    .query({ end });
}

function fetch(): Promise<unknown> {
  return getChainguardTagHistory(
    http,
    CHAINGUARD_REGISTRY,
    'my-org/python',
    '3.14',
    end,
  );
}

describe('modules/datasource/docker/chainguard', () => {
  describe('getChainguardTagHistory', () => {
    it('returns the history for a tag, bounded by end', async () => {
      scope().reply(200, {
        history: [
          { digest: 'sha256:old', updateTimestamp: '2026-06-02T00:00:00.000Z' },
        ],
      });

      await expect(fetch()).resolves.toEqual([
        { digest: 'sha256:old', updateTimestamp: '2026-06-02T00:00:00.000Z' },
      ]);
    });

    it('treats a null history as no entries', async () => {
      // The endpoint sends `null`, not `[]`, when there are no rows.
      scope().reply(200, { history: null });

      await expect(fetch()).resolves.toEqual([]);
    });

    it('drops entries it cannot parse', async () => {
      scope().reply(200, {
        history: [
          { digest: 42, updateTimestamp: '2026-06-02T00:00:00.000Z' },
          { digest: 'sha256:ok', updateTimestamp: '2026-06-03T00:00:00.000Z' },
        ],
      });

      await expect(fetch()).resolves.toEqual([
        { digest: 'sha256:ok', updateTimestamp: '2026-06-03T00:00:00.000Z' },
      ]);
    });

    it('returns null when the registry refuses auth', async () => {
      httpMock.scope(CHAINGUARD_REGISTRY).get('/v2/').reply(401, '', {});

      await expect(fetch()).resolves.toBeNull();
    });

    it('returns null when the registry has no history for the tag', async () => {
      scope().reply(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });

      await expect(fetch()).resolves.toBeNull();
    });

    it('rethrows other registry errors', async () => {
      scope().reply(500);

      await expect(fetch()).rejects.toThrow(/status code 500/);
    });

    it('throws rather than reporting no history when the payload is unreadable', async () => {
      // `history` renamed upstream: this must not look like a tag with no
      // history, or the caller would silently stop rewinding.
      scope().reply(200, { entries: [] });

      await expect(fetch()).rejects.toThrow(/invalid_type|Invalid input/);
    });
  });

  describe('newestEntryAtOrBefore', () => {
    const cutoff = Date.parse('2026-06-13T00:00:00.000Z');

    it('returns the newest entry at or before the cutoff', () => {
      expect(
        newestEntryAtOrBefore(
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

    it('is order-independent', () => {
      // `?end=` pages come back newest-first, unbounded ones oldest-first.
      expect(
        newestEntryAtOrBefore(
          [
            {
              digest: 'sha256:settled',
              updateTimestamp: ts('2026-06-11T00:00:00.000Z'),
            },
            {
              digest: 'sha256:old',
              updateTimestamp: ts('2026-06-02T00:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toMatchObject({ digest: 'sha256:settled' });
    });

    it('treats the cutoff as inclusive', () => {
      expect(
        newestEntryAtOrBefore(
          [
            {
              digest: 'sha256:exact',
              updateTimestamp: ts('2026-06-13T00:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toMatchObject({ digest: 'sha256:exact' });
    });

    it('ignores entries which cannot be dated', () => {
      expect(
        newestEntryAtOrBefore(
          [
            { digest: 'sha256:undated', updateTimestamp: null },
            {
              digest: 'sha256:settled',
              updateTimestamp: ts('2026-06-11T00:00:00.000Z'),
            },
          ],
          cutoff,
        ),
      ).toMatchObject({ digest: 'sha256:settled' });
    });

    it('returns null when nothing is old enough', () => {
      expect(
        newestEntryAtOrBefore(
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
