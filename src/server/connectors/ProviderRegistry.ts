import type { IConnector } from './types.ts';
import { AmazonConnector } from './AmazonConnector.ts';
import type { ProviderCapability } from '../../types/index.ts';
import { isGeminiConfigured } from '../gemini.ts';

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private connectors: Map<string, IConnector> = new Map();

  private constructor() {
    this.register(new AmazonConnector());
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

    const geminiReady = isGeminiConfigured();
    list.push({
      id: 'gemini_multimodal',
      name: 'Gemini Multimodal & Search Grounding',
      nameAr: 'محرك جيميناي للتحليل البصري والترجمة الذكية',
      description: 'Powers product translation and optional image booster analysis.',
      descriptionAr: 'يقوم بترجمة اسم المنتج إلى الإنجليزية وتحليل الصورة الاختيارية لتعزيز دقة البحث.',
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
      notes: 'Active and configured automatically via environment.',
      notesAr: 'مفعل وجاهز تلقائيًا عبر بيئة التشغيل.',
    });

    for (const connector of this.connectors.values()) {
      list.push(connector.capabilities());
    }

    list.push({
      id: 'media_worker',
      name: 'Safe Media Downloader & Verifier Worker',
      nameAr: 'خادم التحميل والفحص الآمن',
      description: 'Server-side media pipeline enforcing SSRF guardrails, ffprobe verification, SHA-256 deduplication, and streamed ZIP packaging.',
      descriptionAr: 'معالج سيرفر متكامل لفحص الروابط، منع SSRF، التحقق عبر ffprobe وبناء حزم التصدير.',
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
