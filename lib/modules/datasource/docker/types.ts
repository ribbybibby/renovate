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

/** The state a rewound tag was in when the `minimumReleaseAge` window opened. */
export interface RewoundTag {
  digest: string;
  releaseTimestamp: Timestamp;
}

/** A tag as the Chainguard platform API reports it. */
export interface ChainguardTag {
  /** UIDP, used to address the tag's history. */
  id: string;
  name: string;
  lastUpdated: Timestamp | null;
}
