import type { Timestamp } from '../../../util/timestamp.ts';
import type { DockerHubTag } from './schema.ts';

export interface DockerHubCacheData {
  items: Record<number, DockerHubTag>;
  updatedAt: string | null;
}

export interface RegistryRepository {
  registryHost: string;
  dockerRepository: string;
}

/** One digest a Chainguard tag has pointed at, and when it was pushed. */
export interface ChainguardTagHistoryEntry {
  digest: string;
  updateTimestamp: Timestamp | null;
}
