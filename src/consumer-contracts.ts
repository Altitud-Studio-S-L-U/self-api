export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface ConsumerCall {
  readonly id: string;
  readonly location: SourceLocation;
  readonly kind: 'fetch';
  readonly method: string | null;
  readonly origin: string | null;
  /** A path segment `{*}` means an encoded, otherwise unknown segment. */
  readonly pathPattern: string | null;
  readonly resolution: 'resolved' | 'unresolved';
  readonly reason?: string;
  /** Direct property reads traced from this call's JSON response, not a complete data-flow graph. */
  readonly responseFields: readonly string[];
  readonly parserLocations: readonly SourceLocation[];
}

export interface SourceInspection {
  readonly calls: readonly ConsumerCall[];
  readonly imports: readonly { packageName: string; location: SourceLocation }[];
  readonly issues: readonly { code: string; location: SourceLocation }[];
}

export interface ConsumerInventory {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly files: readonly { path: string; sha256: string }[];
  readonly calls: readonly ConsumerCall[];
  readonly imports: SourceInspection['imports'];
  readonly issues: SourceInspection['issues'];
  readonly skipped: readonly { path: string; reason: string }[];
  readonly packages: readonly {
    manifest: string;
    dependencies: readonly { name: string; range: string | null; kind: 'runtime' | 'development' | 'optional' | 'peer' }[];
  }[];
  readonly validationCandidates: readonly {
    manifest: string;
    script: string;
    commandSha256: string;
    execution: 'not-authorized';
  }[];
  readonly coverage: 'bounded-native-fetch-syntax';
  readonly codeExecuted: false;
}
