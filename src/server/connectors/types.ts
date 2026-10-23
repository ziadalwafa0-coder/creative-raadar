import {
  SourcePlatform,
  ProviderCapability,
  VisualAttribute,
  SearchSettings,
  CandidateAsset,
  ProvenanceClassification
} from '../../types/index.ts';

export interface IConnector {
  id: SourcePlatform;
  name: string;
  nameAr: string;

  capabilities(): ProviderCapability;
  healthCheck(): Promise<boolean>;

  searchCandidates(
    profile: VisualAttribute,
    settings: SearchSettings,
    targetCount: number
  ): Promise<Partial<CandidateAsset>[]>;

  inspectSource(
    url: string
  ): Promise<{
    title?: string;
    reviewer?: string;
    provenance: ProvenanceClassification;
    verifiedPurchaseEvidence?: string;
    incentiveDisclosure?: string;
    mediaUrl?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    dimensions?: { width: number; height: number };
  }>;

  resolveAccessibleMedia(
    candidate: Partial<CandidateAsset>
  ): Promise<{
    directMediaUrl?: string;
    thumbnailUrl?: string;
    canDownload: boolean;
    unsupportedReason?: string;
  }>;
}
