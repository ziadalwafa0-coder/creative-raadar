import { IConnector } from './types.ts';
import { AmazonConnector } from './AmazonConnector.ts';
import { YouTubeConnector } from './YouTubeConnector.ts';
import { ProviderCapability } from '../../types/index.ts';
import { isGeminiConfigured } from '../gemini.ts';

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private connectors: Map<string, IConnector> = new Map();

  private constructor() {
    this.register(new AmazonConnector());
    this.register(new YouTubeConnector());
  }

  public static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  public register(connector: IConnector): void {
    this.connectors.set(connector.id, connector);
  }

  public get(id: string): IConnector | undefined {
    return this.connectors.get(id);
  }

  public getAllCapabilities(): ProviderCapability[] {
    const list: ProviderCapability[] = [];

    // 1. Gemini Multimodal & Grounding Provider
    const geminiReady = isGeminiConfigured();
    list.push({
      id: 'gemini_multimodal',
      name: 'Gemini Multimodal & Search Grounding',
      nameAr: 'محرك جيميناي للتحليل البصري والبحث الحي',
      description: 'Powers product physical breakdown, must-match detection, and real Google Search grounded discovery.',
      descriptionAr: 'يقوم بالتحليل البصري للمنتج وتحديد السمات الإلزامية والبحث المباشر عبر Google Search.',
      state: geminiReady ? 'ready' : 'missing_config',
      supportedOperations: {
        discovery: true,
        reviewAccess: true,
        visualInspection: true,
        preview: true,
        download: false,
      },
      requiredSecrets: ['GEMINI_API_KEY'],
      configuredSecrets: geminiReady ? ['GEMINI_API_KEY'] : [],
      notes: 'Active and configured automatically via AI Studio environment.',
      notesAr: 'مفعل وجاهز تلقائيًا عبر بيئة الاستوديو.',
    });

    // 2. Connectors
    for (const connector of this.connectors.values()) {
      list.push(connector.capabilities());
    }

    // 3. Media Download & Verification Worker
    list.push({
      id: 'media_worker',
      name: 'Safe Media Downloader & Verifier Worker',
      nameAr: 'خادم التحميل والفحص البصري الآمن',
      description: 'Server-side media pipeline enforcing SSRF guardrails, file integrity checks, SHA-256 deduplication, and ZIP packaging.',
      descriptionAr: 'معالج سيرفر متكامل لفحص الروابط المشبوهة، منع SSRF، استخراج بصمات التكرار وبناء حزم التصدير.',
      state: 'ready',
      supportedOperations: {
        discovery: false,
        reviewAccess: false,
        visualInspection: true,
        preview: true,
        download: true,
      },
      requiredSecrets: [],
      configuredSecrets: [],
      notes: 'Embedded Node.js stream pipeline active.',
      notesAr: 'يعمل محليًا داخل خادم التطبيق بكامل طاقته.',
    });

    return list;
  }
}
