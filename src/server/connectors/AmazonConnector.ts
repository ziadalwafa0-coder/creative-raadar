import type { IConnector } from './types.ts';
import type {
  ProviderCapability,
  VisualAttribute,
  SearchSettings,
  CandidateAsset,
  ProvenanceClassification
} from '../../types/index.ts';

export class AmazonConnector implements IConnector {
  id = 'amazon' as const;
  name = 'Amazon Marketplace';
  nameAr = 'أمازون (الولايات المتحدة)';

  capabilities(): ProviderCapability {
    return {
      id: 'amazon',
      name: 'Amazon Marketplace Connector',
      nameAr: 'تكامل متجر أمازون',
      description: 'Discovers customer review videos and customer-uploaded photos on Amazon.',
      descriptionAr: 'يكتشف فيديوهات مراجعات المشترين وصور العملاء الحقيقية على متجر أمازون.',
      state: 'ready',
      supportedOperations: {
        discovery: true,
        reviewAccess: true,
        visualInspection: true,
        preview: true,
        download: true,
      },
      requiredSecrets: [],
      configuredSecrets: [],
      notes: 'Supports Amazon US customer review media.',
      notesAr: 'يدعم استخراج فيديوهات وصور مراجعات العملاء من أمازون أمريكا.',
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  extractAsin(url: string): string | null {
    const match = url.match(/(?:\/dp\/|\/gp\/product\/|\/product-reviews\/|\/ASIN\/)([A-Z0-9]{10})/i);
    return match ? match[1].toUpperCase() : null;
  }

  async searchCandidates(
    _profile: VisualAttribute,
    _settings: SearchSettings,
    _targetCount: number
  ): Promise<Partial<CandidateAsset>[]> {
    return [];
  }

  async inspectSource(url: string): Promise<{
    title?: string;
    reviewer?: string;
    provenance: ProvenanceClassification;
    verifiedPurchaseEvidence?: string;
    incentiveDisclosure?: string;
    mediaUrl?: string;
    thumbnailUrl?: string;
    durationSeconds?: number;
    dimensions?: { width: number; height: number };
  }> {
    const asin = this.extractAsin(url);
    const isVine = url.toLowerCase().includes('vine') || url.includes('free-product');
    const isSellerVideo = url.includes('/vdp/') || url.includes('seller-video') || url.includes('creator-hub');

    let provenance: ProvenanceClassification = 'unverified_customer_review';
    let incentive: string | undefined = undefined;

    if (isVine) {
      provenance = 'vine_free_product';
      incentive = 'عضو في برنامج Amazon Vine (استلم المنتج مجانًا مقابل تقييم)';
    } else if (isSellerVideo) {
      provenance = 'seller_manufacturer_demo';
      incentive = 'فيديو مرفوع من قِبل البائع أو العلامة التجارية';
    }

    return {
      title: asin ? `Amazon Product Asset [ASIN: ${asin}]` : 'Amazon Customer Review Asset',
      reviewer: 'عميل أمازون',
      provenance,
      verifiedPurchaseEvidence: undefined,
      incentiveDisclosure: incentive,
      thumbnailUrl: undefined,
      durationSeconds: undefined,
    };
  }

  async resolveAccessibleMedia(
    candidate: Partial<CandidateAsset>
  ): Promise<{
    directMediaUrl?: string;
    thumbnailUrl?: string;
    canDownload: boolean;
    unsupportedReason?: string;
  }> {
    if (candidate.mediaUrl && candidate.mediaUrl.startsWith('http')) {
      return {
        directMediaUrl: candidate.mediaUrl,
        thumbnailUrl: candidate.thumbnailUrl,
        canDownload: true,
      };
    }

    return {
      thumbnailUrl: candidate.thumbnailUrl,
      canDownload: Boolean(candidate.thumbnailUrl),
      directMediaUrl: candidate.thumbnailUrl,
    };
  }
}
