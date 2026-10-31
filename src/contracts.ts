export interface SnapshotMetadata {
  readonly sha256: string;
  readonly byteLength: number;
  readonly specificationVersion: string;
  readonly apiVersion: string;
}

export interface LocalSnapshot {
  readonly metadata: SnapshotMetadata;
  readonly json: string;
}

export interface ApiChange {
  readonly id: string;
  readonly level: 'warning' | 'error';
  readonly text: string;
  readonly operation?: string;
  readonly path?: string;
}

/** Local evidence recorded with the exact contract bytes used for inspection. */
export interface ComparisonReport {
  readonly schemaVersion: 1;
  readonly engine: { readonly name: 'oasdiff'; readonly version: string };
  readonly base: SnapshotMetadata;
  readonly revision: SnapshotMetadata;
  readonly contentChanged: boolean;
  readonly status: 'breaking-changes' | 'no-breaking-changes';
  readonly changes: readonly ApiChange[];
  readonly coverage: 'structural-contract-only';
  readonly consumerImpact: 'not-analyzed';
}
