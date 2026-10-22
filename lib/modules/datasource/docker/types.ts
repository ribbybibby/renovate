import type { DockerHubTag } from './schema.ts';

export interface DockerHubCacheData {
  items: Record<number, DockerHubTag>;
  updatedAt: string | null;
}

export interface RegistryRepository {
  registryHost: string;
  dockerRepository: string;
}

export interface ChainguardReleasesOptions {
  apiUrl?: string;
  /**
   * The `minimumReleaseAge` window, in milliseconds, that the result has to
   * satisfy. Zero disables the tag history walk entirely.
   */
  minimumReleaseAgeMs?: number;
}
