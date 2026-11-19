interface PublishedAsset {
  path: string;
  bytes: number;
  sha256: string;
}

export interface VerifiedWebAsset extends PublishedAsset {
  file: string;
  content?: Buffer;
}

export function brandedModule(text: string): string;
export function verifyOfficialWebAssets(root?: string, options?: { officialUi?: string; userContent?: string; onChatStarInput?: (name: string, source: string) => void; onEditRetryInput?: (name: string, source: string) => void }): {
  entry: string;
  document: string;
  files: VerifiedWebAsset[];
  manifest: {
    buildId: string;
    archiveSha256: string;
    files: PublishedAsset[];
  } & Record<string, unknown>;
};
