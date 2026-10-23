import { ExternalHostError } from '../../types/errors/external-host-error.ts';
import type { Timestamp } from '../../util/timestamp.ts';
import * as _datasourceCommon from './common.ts';
import { Datasource } from './datasource.ts';
import { getDigestAt } from './digest-at.ts';
import type {
  DigestAtConfig,
  GetReleasesConfig,
  HistoricDigest,
  Release,
  ReleaseResult,
} from './types.ts';

vi.mock('./common.ts');
const { getDatasourceFor } = vi.mocked(_datasourceCommon);

const before = '2026-06-13T00:00:00.000Z' as Timestamp;
const historic: HistoricDigest = {
  digest: 'sha256:settled',
  releaseTimestamp: '2026-06-11T00:00:00.000Z' as Timestamp,
};

class PlainDatasource extends Datasource {
  constructor() {
    super('some-datasource');
  }

  override getReleases(_: GetReleasesConfig): Promise<ReleaseResult | null> {
    return Promise.resolve(null);
  }
}

class RewindingDatasource extends PlainDatasource {
  seen: { config: DigestAtConfig; newValue: string; before: Timestamp }[] = [];

  override getDigestAt(
    config: DigestAtConfig,
    newValue: string,
    at: Timestamp,
  ): Promise<HistoricDigest | null> {
    this.seen.push({ config, newValue, before: at });
    return Promise.resolve(historic);
  }
}

describe('modules/datasource/digest-at', () => {
  const release: Release = { version: '3.14' };

  it('returns null when the datasource field is empty', async () => {
    await expect(getDigestAt({}, release, before)).resolves.toBeNull();
  });

  it('returns null when the datasource cannot be resolved', async () => {
    getDatasourceFor.mockReturnValueOnce(null);

    await expect(
      getDigestAt({ datasource: 'some-datasource' }, release, before),
    ).resolves.toBeNull();
  });

  it('returns null when the datasource does not implement the hook', async () => {
    getDatasourceFor.mockReturnValueOnce(new PlainDatasource());

    await expect(
      getDigestAt(
        { datasource: 'some-datasource', packageName: 'foo' },
        release,
        before,
      ),
    ).resolves.toBeNull();
  });

  it('returns null for an empty packageName', async () => {
    getDatasourceFor.mockReturnValueOnce(new RewindingDatasource());

    await expect(
      getDigestAt({ datasource: 'some-datasource' }, release, before),
    ).resolves.toBeNull();
  });

  it('returns the digest the datasource resolved', async () => {
    const ds = new RewindingDatasource();
    getDatasourceFor.mockReturnValueOnce(ds);

    await expect(
      getDigestAt(
        {
          datasource: 'some-datasource',
          packageName: 'foo',
          registryUrl: 'https://example.com',
        },
        release,
        before,
      ),
    ).resolves.toEqual(historic);
    expect(ds.seen).toEqual([
      {
        config: { packageName: 'foo', registryUrl: 'https://example.com' },
        newValue: '3.14',
        before,
      },
    ]);
  });

  it('prefers the registry which reported the release', async () => {
    const ds = new RewindingDatasource();
    getDatasourceFor.mockReturnValueOnce(ds);

    await getDigestAt(
      {
        datasource: 'some-datasource',
        packageName: 'foo',
        registryUrls: ['https://configured.example.com'],
      },
      { ...release, registryUrl: 'https://reported.example.com' },
      before,
    );

    expect(ds.seen[0].config.registryUrl).toBe('https://reported.example.com');
  });

  it('falls back to the first configured registry', async () => {
    const ds = new RewindingDatasource();
    getDatasourceFor.mockReturnValueOnce(ds);

    await getDigestAt(
      {
        datasource: 'some-datasource',
        packageName: 'foo',
        registryUrls: ['https://configured.example.com'],
      },
      release,
      before,
    );

    expect(ds.seen[0].config.registryUrl).toBe(
      'https://configured.example.com',
    );
  });

  it('passes the original tag when the version was rewritten', async () => {
    const ds = new RewindingDatasource();
    getDatasourceFor.mockReturnValueOnce(ds);

    await getDigestAt(
      { datasource: 'some-datasource', packageName: 'foo' },
      { version: '3.14', versionOrig: 'v3.14' },
      before,
    );

    expect(ds.seen[0].newValue).toBe('v3.14');
  });

  it('returns null when the datasource throws', async () => {
    const ds = new RewindingDatasource();
    vi.spyOn(ds, 'getDigestAt').mockRejectedValueOnce(new Error('boom'));
    getDatasourceFor.mockReturnValueOnce(ds);

    await expect(
      getDigestAt(
        { datasource: 'some-datasource', packageName: 'foo' },
        release,
        before,
      ),
    ).resolves.toBeNull();
  });

  it('rethrows ExternalHostError so the run can abort', async () => {
    const ds = new RewindingDatasource();
    vi.spyOn(ds, 'getDigestAt').mockRejectedValueOnce(
      new ExternalHostError(new Error('down')),
    );
    getDatasourceFor.mockReturnValueOnce(ds);

    await expect(
      getDigestAt(
        { datasource: 'some-datasource', packageName: 'foo' },
        release,
        before,
      ),
    ).rejects.toThrow(ExternalHostError);
  });
});
