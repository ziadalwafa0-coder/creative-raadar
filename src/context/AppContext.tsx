import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Language, translations } from '../translations/index.ts';
import {
  Project,
  CandidateAsset,
  ProviderCapability,
  WorkspaceUsage,
  SwipeVerdict,
  CreativeHookAnalysis,
  MatchMode,
  IdentityCardV2Client,
  RejectedCandidateItem,
  SearchBreakdownSummary,
} from '../types/index.ts';
import { computeWinnerSignal } from '../utils/rules.ts';

export type NavTab = 'search' | 'projects' | 'library' | 'integrations' | 'usage' | 'settings';

interface AppContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: typeof translations['ar'];
  isAuthenticated: boolean;
  isAuthChecking: boolean;
  login: (code: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  currentProject: Project | null;
  setCurrentProject: (proj: Project | null) => void;
  projects: Project[];
  refreshProjects: () => Promise<void>;
  library: CandidateAsset[];
  refreshLibrary: () => Promise<void>;
  saveToSwipeFile: (
    asset: CandidateAsset,
    verdict?: SwipeVerdict,
    editorNotes?: string
  ) => Promise<CandidateAsset | null>;
  updateSwipeItem: (
    assetId: string,
    updates: {
      swipeVerdict?: SwipeVerdict;
      editorNotes?: string;
      creativeAnalysis?: CreativeHookAnalysis;
    }
  ) => Promise<CandidateAsset | null>;
  removeFromSwipeFile: (assetId: string) => Promise<boolean>;
  generateCreativeBrief: (params: {
    productName: string;
    videoTitle?: string;
    platform?: string;
    reviewerOrChannel?: string;
    assetId?: string;
  }) => Promise<CreativeHookAnalysis | null>;
  providers: ProviderCapability[];
  refreshProviders: () => Promise<void>;
  usage: WorkspaceUsage | null;
  refreshUsage: () => Promise<void>;
  isNewSearchOpen: boolean;
  setIsNewSearchOpen: (open: boolean) => void;
  droppedFile: File | null;
  setDroppedFile: (file: File | null) => void;
  showToast: (message: string, type?: 'info' | 'success' | 'warn' | 'error') => void;
  toast: { message: string; type: 'info' | 'success' | 'warn' | 'error' } | null;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  fetchMediaBlob: (url: string, silent?: boolean) => Promise<{ blob: Blob; filename?: string } | null>;
  downloadWithSession: (url: string, fallbackFilename: string) => Promise<boolean>;
  startStreamingSearch: (params: {
    productName: string;
    productUrl?: string;
    mediaType: Project['mediaTypeRequested'];
    sourcePlatform?: 'all' | 'amazon' | 'tiktok';
    targetVideoCount: number;
    targetAmazonVideoCount?: number;
    targetTikTokVideoCount?: number;
    targetPhotoCount: number;
    referenceImage?: string | null;
    matchMode?: MatchMode;
    includeSimilar?: boolean;
    mustMatch?: string[];
    mustNotBe?: string[];
    identityCard?: IdentityCardV2Client | null;
  }) => Promise<void>;
  acceptRejectedCandidate: (item: RejectedCandidateItem) => Promise<void>;
  cancelStreamingSearch: () => void;
  autoResolvedProductName: string | null;
  sessionId: string;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const AUTH_TOKEN_STORAGE_KEY = 'cr_auth_token';

function getStoredAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredAuthToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch {}
}

function isTerminalJobState(state?: Project['jobState']): boolean {
  return (
    state === 'completed' ||
    state === 'completed_partial' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'idle'
  );
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authToken, setAuthTokenState] = useState<string | null>(() => getStoredAuthToken());
  const authTokenRef = useRef<string | null>(authToken);
  authTokenRef.current = authToken;

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isAuthChecking, setIsAuthChecking] = useState<boolean>(true);

  const [lang, setLangState] = useState<Language>('ar');
  const [activeTab, setActiveTab] = useState<NavTab>('search');
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [library, setLibrary] = useState<CandidateAsset[]>([]);
  const [providers, setProviders] = useState<ProviderCapability[]>([]);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [isNewSearchOpen, setIsNewSearchOpen] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [autoResolvedProductName, setAutoResolvedProductName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warn' | 'error' } | null>(null);

  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const activeSearchIdRef = useRef<string | null>(null);
  const mediaBlobCacheRef = useRef<Map<string, { blob: Blob; filename?: string }>>(new Map());
  const inflightBlobFetchRef = useRef<Map<string, Promise<{ blob: Blob; filename?: string } | null>>>(
    new Map()
  );

  const getCanonicalMediaCacheKey = (rawEndpointUrl: string): string => {
    try {
      const parsed = new URL(rawEndpointUrl, window.location.origin);
      if (parsed.pathname === '/api/stream-search/download') {
        const target = parsed.searchParams.get('url') || '';
        const type = parsed.searchParams.get('type') || 'video';
        if (target) return `stream:${type}:${target}`;
      }
      return parsed.pathname;
    } catch {
      return rawEndpointUrl;
    }
  };

  const cancelStreamingSearch = () => {
    activeSearchIdRef.current = null;
    if (streamReaderRef.current) {
      try {
        streamReaderRef.current.cancel();
      } catch {}
      streamReaderRef.current = null;
    }
    if (streamAbortControllerRef.current) {
      try {
        streamAbortControllerRef.current.abort();
      } catch {}
      streamAbortControllerRef.current = null;
    }
    setCurrentProject((prev) => {
      if (!prev || !prev.id.startsWith('ephemeral-')) return prev;
      return {
        ...prev,
        jobState: 'cancelled',
        logs: [
          ...prev.logs,
          {
            timestamp: new Date().toISOString(),
            stage: 'cancelled',
            message: 'تم إيقاف عملية البحث بطلب من المستخدم.',
            level: 'warn',
          },
        ],
      };
    });
  };

  useEffect(() => {
    const handlePageHide = () => {
      if (streamAbortControllerRef.current) {
        try {
          streamAbortControllerRef.current.abort();
        } catch {}
      }
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      handlePageHide();
    };
  }, []);

  const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers || {});
    const token = authTokenRef.current || getStoredAuthToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await fetch(input, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (!urlStr.includes('/api/auth/login') && !urlStr.includes('/api/auth/session')) {
        setStoredAuthToken(null);
        setAuthTokenState(null);
        setIsAuthenticated(false);
        setCurrentProject(null);
        setProjects([]);
      }
    }
    return res;
  };

  const showToast = (message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 4500);
  };

  const startStreamingSearch = async (params: {
    productName: string;
    productUrl?: string;
    mediaType: Project['mediaTypeRequested'];
    sourcePlatform?: 'all' | 'amazon' | 'tiktok';
    targetVideoCount: number;
    targetAmazonVideoCount?: number;
    targetTikTokVideoCount?: number;
    targetPhotoCount: number;
    referenceImage?: string | null;
    matchMode?: MatchMode;
    includeSimilar?: boolean;
    mustMatch?: string[];
    mustNotBe?: string[];
    identityCard?: IdentityCardV2Client | null;
  }) => {
    // 1. Cancel any previous streaming search and clear previous results
    if (streamReaderRef.current) {
      try {
        streamReaderRef.current.cancel();
      } catch {}
      streamReaderRef.current = null;
    }
    if (streamAbortControllerRef.current) {
      try {
        streamAbortControllerRef.current.abort();
      } catch {}
    }
    const abortController = new AbortController();
    streamAbortControllerRef.current = abortController;

    const searchId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    activeSearchIdRef.current = searchId;
    const projectId = `ephemeral-${searchId}`;

    const sourcePlatform = params.sourcePlatform || 'all';
    const hasCustomBothCounts =
      sourcePlatform === 'all' &&
      (typeof params.targetAmazonVideoCount === 'number' ||
        typeof params.targetTikTokVideoCount === 'number');

    const amazonVideosRequested =
      params.mediaType === 'photo'
        ? 0
        : sourcePlatform === 'tiktok'
        ? 0
        : typeof params.targetAmazonVideoCount === 'number'
        ? Math.max(1, params.targetAmazonVideoCount)
        : params.targetVideoCount;

    const tiktokVideosRequested =
      params.mediaType === 'photo'
        ? 0
        : sourcePlatform === 'amazon'
        ? 0
        : typeof params.targetTikTokVideoCount === 'number'
        ? Math.max(1, params.targetTikTokVideoCount)
        : params.targetVideoCount;

    const effectiveVideoTarget =
      params.mediaType === 'photo'
        ? 0
        : hasCustomBothCounts
        ? amazonVideosRequested + tiktokVideosRequested
        : params.targetVideoCount;
    const effectivePhotoTarget = params.mediaType === 'video' ? 0 : params.targetPhotoCount;
    const totalTarget = effectiveVideoTarget + effectivePhotoTarget;

    const sourcePriority: Project['settings']['sourcePriority'] =
      sourcePlatform === 'tiktok'
        ? ['tiktok']
        : sourcePlatform === 'amazon'
        ? ['amazon']
        : ['amazon', 'tiktok'];

    const resolvedMatchMode: MatchMode = params.matchMode || 'same_design';
    const resolvedIncludeSimilar = Boolean(params.includeSimilar);

    const initialProject: Project = {
      id: projectId,
      name: params.productName,
      userNotes: params.productName,
      productListingUrl: params.productUrl || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      referenceImages: params.referenceImage
        ? [
            {
              id: `img-${Date.now()}`,
              url: params.referenceImage,
              mimeType: 'image/jpeg',
              fileName: 'reference.jpg',
            },
          ]
        : [],
      mediaTypeRequested: params.mediaType,
      targetVideoCount: effectiveVideoTarget,
      targetPhotoCount: effectivePhotoTarget,
      settings: {
        strictness: resolvedMatchMode === 'strict_color' ? 'exact' : 'color_allowed',
        matchMode: resolvedMatchMode,
        includeSimilar: resolvedIncludeSimilar,
        contentSources: 'customer_only',
        sourcePriority,
        preferredMarketplaces: ['US'],
        preferredLanguages: ['ar', 'en'],
        excludeWorkspaceProjects: true,
        minDurationSeconds: 15,
        preserveAudio: true,
        maxSearchDepth: 5,
        maxProcessingTimeSeconds: 120,
        estimatedBudgetUsd: 0,
      },
      jobState: 'searching',
      counters: {
        candidatesDiscovered: 0,
        sourcesInspected: 0,
        visuallyMatchedAssets: 0,
        downloadedAssets: 0,
        verifiedAssets: 0,
        rejectedDuplicates: 0,
        targetCount: totalTarget,
      },
      logs: [
        {
          timestamp: new Date().toISOString(),
          stage: 'searching',
          message: params.referenceImage
            ? 'جاري رفع صورة المنتج وفحص تصميمه ومواصفاته بالذكاء الاصطناعي...'
            : sourcePlatform === 'tiktok'
            ? `جاري بدء البحث المباشر في فيديوهات تيك توك (${effectiveVideoTarget} فيديو)...`
            : sourcePlatform === 'amazon'
            ? `جاري بدء البحث المباشر في أمازون (${effectiveVideoTarget} فيديو)...`
            : `جاري بدء البحث المباشر في المنصتين (${amazonVideosRequested} فيديو أمازون + ${tiktokVideosRequested} فيديو تيك توك)...`,
          level: 'info',
        },
      ],
      candidates: [],
      rejectedCandidates: [],
      identityCard: params.identityCard || undefined,
    };

    setAutoResolvedProductName(null);
    setCurrentProject(initialProject);
    setActiveTab('search');

    try {
      const res = await apiFetch('/api/stream-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          searchId,
          productName: params.productName,
          productUrl: params.productUrl,
          mediaType: params.mediaType,
          sourcePlatform,
          targetVideoCount: effectiveVideoTarget,
          targetAmazonVideoCount:
            sourcePlatform === 'all' ? amazonVideosRequested : undefined,
          targetTikTokVideoCount:
            sourcePlatform === 'all' ? tiktokVideosRequested : undefined,
          targetPhotoCount: effectivePhotoTarget,
          hasReferenceImage: Boolean(params.referenceImage),
          referenceImage: params.referenceImage || undefined,
          matchMode: resolvedMatchMode,
          includeSimilar: resolvedIncludeSimilar,
          mustMatch: params.mustMatch || params.identityCard?.mustMatch,
          mustNotBe: params.mustNotBe || params.identityCard?.mustNotBe,
        }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'تعذر بدء البحث المباشر');
      }

      const reader = res.body.getReader();
      streamReaderRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';

      const processLine = (line: string) => {
        if (abortController.signal.aborted || activeSearchIdRef.current !== searchId) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const evt = JSON.parse(trimmed);
          // Strictly ignore any event from a previous searchId!
          if (!evt || evt.searchId !== searchId || activeSearchIdRef.current !== searchId) return;

          if (evt.type === 'identity' && evt.identityCard) {
            const card: IdentityCardV2Client = evt.identityCard;
            if (card.nameEn) {
              setAutoResolvedProductName(card.nameEn);
            }
            setCurrentProject((prev) => {
              if (!prev || prev.id !== projectId) return prev;
              return {
                ...prev,
                name: card.nameEn || prev.name,
                identityCard: card,
              };
            });
          } else if (evt.type === 'rejected' && evt.rejected) {
            const rej: RejectedCandidateItem = evt.rejected;
            setCurrentProject((prev) => {
              if (!prev || prev.id !== projectId) return prev;
              const existing = prev.rejectedCandidates || [];
              if (existing.some((r) => r.id === rej.id)) return prev;
              return {
                ...prev,
                rejectedCandidates: [...existing, rej],
              };
            });
          } else if (evt.type === 'warning' || evt.type === 'progress') {
            if (typeof evt.resolvedProductName === 'string' && evt.resolvedProductName.trim()) {
              setAutoResolvedProductName(evt.resolvedProductName.trim());
            }
            setCurrentProject((prev) => {
              if (!prev || prev.id !== projectId) return prev;
              const updatedName =
                typeof evt.resolvedProductName === 'string' && evt.resolvedProductName.trim()
                  ? evt.resolvedProductName.trim()
                  : prev.name;
              return {
                ...prev,
                name: updatedName,
                counters: {
                  ...prev.counters,
                  sourcesInspected: evt.pagesInspected ?? prev.counters.sourcesInspected,
                },
                logs: [
                  ...prev.logs,
                  {
                    timestamp: evt.timestamp || new Date().toISOString(),
                    stage: 'searching',
                    message: evt.message,
                    level: evt.type === 'warning' ? 'warn' : 'info',
                  },
                ],
              };
            });
          } else if (evt.type === 'result' && evt.asset) {
            const a = evt.asset;
            if (a.searchId && a.searchId !== searchId) return;
            const isTikTokAsset = a.platform === 'tiktok';
            const newCandidate: CandidateAsset = {
              id: a.id,
              projectId,
              title: a.title,
              mediaType: a.mediaType,
              platform: a.platform || 'amazon',
              sourceUrl: a.sourceUrl,
              productListingUrl: a.productListingUrl,
              reviewerOrChannel: a.reviewerOrChannel,
              reviewId: a.reviewId,
              durationSeconds: a.durationSeconds,
              ratingCount: typeof a.ratingCount === 'number' ? a.ratingCount : undefined,
              thumbnailUrl: a.thumbnailUrl || '',
              posterSource: a.posterSource,
              verifiedByAi: a.verifiedByAi !== false,
              verificationStage: a.verificationStage,
              verdictTier: a.verdictTier,
              embedHtml: a.embedHtml,
              downloadFailureReason: a.downloadFailureReason,
              mediaUrl: a.mediaUrl,
              downloadUrl: a.downloadUrl || a.mediaUrl,
              provenance: a.provenance || 'unverified_customer_review',
              matchCategory: a.matchCategory || 'exact_design',
              matchScore: a.matchScore || 92,
              userFacingMatchLabel: a.userFacingMatchLabel || 'نفس المنتج (تطابق مؤكد)',
              visibleDifferences: [],
              supportingObservations: [
                isTikTokAsset
                  ? 'مطابقة مباشرة مع المنتج المطلوب على تيك توك (TikTok)'
                  : 'مطابقة مباشرة مع المنتج المطلوب على أمازون',
              ],
              unknowns: [],
              contentDescription: isTikTokAsset
                ? 'فيديو مراجعة وعرض منتج إيجابي على تيك توك'
                : 'مراجعة عميل إيجابية على أمازون',
              sentiment: 'positive',
              downloadStatus: a.downloadFailureReason ? 'source_only' : 'verified_available',
              downloadError: a.downloadFailureReason,
              collectedAt: a.collectedAt || new Date().toISOString(),
              rightsStatus: 'public_reference',
              selectedForExport: !a.downloadFailureReason,
              winnerSignal: computeWinnerSignal({
                platform: a.platform || 'amazon',
                ratingCount: typeof a.ratingCount === 'number' ? a.ratingCount : undefined,
                durationSeconds: a.durationSeconds,
                matchScore: a.matchScore || 92,
                provenance: a.provenance || 'unverified_customer_review',
              }),
            };

            setCurrentProject((prev) => {
              if (!prev || prev.id !== projectId) return prev;
              if (prev.candidates.some((c) => c.id === newCandidate.id || c.mediaUrl === newCandidate.mediaUrl)) {
                return prev;
              }
              const nextCandidates = [...prev.candidates, newCandidate];
              return {
                ...prev,
                candidates: nextCandidates,
                counters: {
                  ...prev.counters,
                  candidatesDiscovered: nextCandidates.length,
                  visuallyMatchedAssets: nextCandidates.length,
                  downloadedAssets: nextCandidates.length,
                  verifiedAssets: nextCandidates.length,
                },
              };
            });
          } else if (evt.type === 'completed') {
            setCurrentProject((prev) => {
              if (!prev || prev.id !== projectId) return prev;
              const found = prev.candidates.length;
              const finalState: Project['jobState'] =
                found >= totalTarget ? 'completed' : 'completed_partial';
              const breakdown: SearchBreakdownSummary | undefined = evt.breakdownSummary;

              return {
                ...prev,
                jobState: finalState,
                breakdownSummary: breakdown || prev.breakdownSummary,
                logs: [
                  ...prev.logs,
                  {
                    timestamp: evt.timestamp || new Date().toISOString(),
                    stage: finalState,
                    message:
                      evt.reasonIfPartial ||
                      `اكتمل البحث بنجاح (${found} عنصر جاهز للمعاينة والتنزيل).`,
                    level: found > 0 ? 'success' : 'warn',
                  },
                ],
              };
            });
          } else if (evt.type === 'failed') {
            setCurrentProject((prev) => {
              if (!prev || prev.id !== projectId) return prev;
              return {
                ...prev,
                jobState: 'failed',
                logs: [
                  ...prev.logs,
                  {
                    timestamp: evt.timestamp || new Date().toISOString(),
                    stage: 'failed',
                    message: evt.error || 'حدث خطأ أثناء البحث',
                    level: 'error',
                  },
                ],
              };
            });
          }
        } catch {}
      };

      while (true) {
        if (abortController.signal.aborted || activeSearchIdRef.current !== searchId) break;
        const { done, value } = await reader.read();
        if (done || abortController.signal.aborted || activeSearchIdRef.current !== searchId) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
        }
      }
      if (buffer.trim() && !abortController.signal.aborted && activeSearchIdRef.current === searchId) {
        processLine(buffer);
      }
    } catch (err: any) {
      if (abortController.signal.aborted || activeSearchIdRef.current !== searchId) return;
      showToast(err?.message || 'حدث خطأ أثناء البحث المباشر', 'error');
      setCurrentProject((prev) =>
        prev && prev.id === projectId ? { ...prev, jobState: 'failed' } : prev
      );
    } finally {
      if (streamReaderRef.current) {
        streamReaderRef.current = null;
      }
    }
  };

  const acceptRejectedCandidate = async (item: RejectedCandidateItem): Promise<void> => {
    try {
      const imageHash = currentProject?.identityCard?.imageHash || 'default';
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageHash,
          candidateId: item.id,
          candidateTitle: item.title,
          candidateUrl: item.url,
          previousRejectionReasonAr: item.reasonAr,
          userAction: 'accept',
        }),
      });
      if (!res.ok) {
        showToast('تعذر حفظ قبول العنصر', 'error');
        return;
      }
      const data = await res.json();
      const extracted = Array.isArray(data?.extractedAssets) ? data.extractedAssets : [];

      setCurrentProject((prev) => {
        if (!prev) return prev;
        const nextRejected = (prev.rejectedCandidates || []).map((r) =>
          r.id === item.id ? { ...r, acceptedByUser: true } : r
        );
        const mappedExtracted: CandidateAsset[] = extracted.map((a: any) => ({
          id: a.id,
          projectId: prev.id,
          title: a.title,
          mediaType: a.mediaType || 'video',
          platform: a.platform || 'amazon',
          sourceUrl: a.sourceUrl,
          productListingUrl: a.productListingUrl,
          reviewerOrChannel: a.reviewerOrChannel,
          reviewId: a.reviewId,
          thumbnailUrl: a.thumbnailUrl || item.imageUrl || '',
          posterSource: a.posterSource || 'real_video_frame',
          verifiedByAi: true,
          verificationStage: 'user_feedback_accepted',
          mediaUrl: a.mediaUrl,
          downloadUrl: a.downloadUrl || a.mediaUrl,
          provenance: a.provenance || 'unverified_customer_review',
          matchCategory: 'permitted_variation',
          matchScore: 95,
          userFacingMatchLabel: 'تم قبوله يدوياً بواسطة المستخدم',
          visibleDifferences: [],
          supportingObservations: ['تم قبوله يدوياً وحفظه كإشارة تدريب للتحقق البصري'],
          unknowns: [],
          contentDescription: a.title,
          sentiment: 'positive',
          downloadStatus: 'verified_available',
          collectedAt: a.collectedAt || new Date().toISOString(),
          rightsStatus: 'public_reference',
          selectedForExport: true,
        }));

        const nextCandidates = [...prev.candidates];
        for (const mc of mappedExtracted) {
          if (!nextCandidates.some((c) => c.id === mc.id || c.mediaUrl === mc.mediaUrl)) {
            nextCandidates.push(mc);
          }
        }

        return {
          ...prev,
          rejectedCandidates: nextRejected,
          candidates: nextCandidates,
          counters: {
            ...prev.counters,
            candidatesDiscovered: nextCandidates.length,
            visuallyMatchedAssets: nextCandidates.length,
            downloadedAssets: nextCandidates.length,
            verifiedAssets: nextCandidates.length,
          },
        };
      });

      showToast(
        extracted.length > 0
          ? `تم قبول العنصر وإضافة ${extracted.length} فيديو مراجعة إلى النتائج`
          : 'تم قبول العنصر وحفظ تفضيلك لعمليات التحقق القادمة',
        'success'
      );
    } catch {
      showToast('تعذر الاتصال بالخادم لحفظ قبول العنصر', 'error');
    }
  };

  const login = async (code: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: code.trim().toLowerCase() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.authenticated) {
        return {
          ok: false,
          error: data.error || 'كود الدخول غير صحيح',
        };
      }

      if (data.token) {
        setStoredAuthToken(data.token);
        setAuthTokenState(data.token);
        authTokenRef.current = data.token;
      }
      setIsAuthenticated(true);
      await Promise.all([refreshProjects(), refreshLibrary()]);
      return { ok: true };
    } catch {
      return { ok: false, error: 'تعذر الاتصال بالخادم. يرجى المحاولة مرة أخرى.' };
    }
  };

  const logout = async (): Promise<void> => {
    cancelStreamingSearch();
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setStoredAuthToken(null);
    setAuthTokenState(null);
    authTokenRef.current = null;
    setIsAuthenticated(false);
    setCurrentProject(null);
    setProjects([]);
    setActiveTab('search');
  };

  const fetchMediaBlob = async (
    url: string,
    silent = false
  ): Promise<{ blob: Blob; filename?: string } | null> => {
    const cacheKey = getCanonicalMediaCacheKey(url);
    const cached = mediaBlobCacheRef.current.get(cacheKey);
    if (cached && cached.blob.size > 0) {
      return cached;
    }

    const existingInflight = inflightBlobFetchRef.current.get(cacheKey);
    if (existingInflight) {
      return existingInflight;
    }

    const fetchPromise = (async (): Promise<{ blob: Blob; filename?: string } | null> => {
      try {
        const res = await apiFetch(url);
        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        if (!res.ok || contentType.includes('application/json')) {
          if (!silent) {
            const errPayload = await res
              .json()
              .catch(() => ({ error: 'تعذر تنزيل الملف المطلوب' }));
            showToast(errPayload.error || 'تعذر تنزيل الملف المطلوب', 'error');
          }
          return null;
        }

        let filename: string | undefined;
        const disposition = res.headers.get('content-disposition');
        if (disposition) {
          const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
          const stdMatch = disposition.match(/filename="?([^";]+)"?/i);
          if (utf8Match?.[1]) {
            filename = decodeURIComponent(utf8Match[1]);
          } else if (stdMatch?.[1]) {
            try {
              filename = decodeURIComponent(stdMatch[1]);
            } catch {
              filename = stdMatch[1];
            }
          }
        }

        const blob = await res.blob();
        if (blob.size === 0) {
          if (!silent) showToast('الملف المستلم فارغ', 'error');
          return null;
        }

        // Bound client-side cache to 25 media blobs to keep memory usage clean
        if (mediaBlobCacheRef.current.size >= 25) {
          const oldestKey = mediaBlobCacheRef.current.keys().next().value;
          if (oldestKey) mediaBlobCacheRef.current.delete(oldestKey);
        }
        const entry = { blob, filename };
        mediaBlobCacheRef.current.set(cacheKey, entry);
        return entry;
      } catch (err) {
        if (!silent) {
          console.error('[Download Error]', err);
          showToast('حدث خطأ أثناء الاتصال بالخادم لتنزيل الملف', 'error');
        }
        return null;
      } finally {
        inflightBlobFetchRef.current.delete(cacheKey);
      }
    })();

    inflightBlobFetchRef.current.set(cacheKey, fetchPromise);
    return fetchPromise;
  };

  const downloadWithSession = async (url: string, fallbackFilename: string): Promise<boolean> => {
    const result = await fetchMediaBlob(url, false);
    if (!result || result.blob.size === 0) {
      return false;
    }

    const filename = result.filename || fallbackFilename;
    const blobUrl = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 60000);

    return true;
  };

  const setLang = (newLang: Language) => {
    setLangState(newLang);
    document.documentElement.lang = newLang;
    document.documentElement.dir = newLang === 'ar' ? 'rtl' : 'ltr';
  };

  const refreshProjects = async () => {
    try {
      const res = await apiFetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        const list: Project[] = data.projects || [];
        setProjects(list);
        setCurrentProject((prev) => {
          if (!prev || prev.id.startsWith('ephemeral-')) return prev;
          return list.find((p) => p.id === prev.id) || prev;
        });
      }
    } catch (err) {
      console.warn('[Fetch Projects Failed]', err);
    }
  };

  const refreshLibrary = async () => {
    try {
      const res = await apiFetch('/api/library');
      if (res.ok) {
        const data = await res.json();
        setLibrary(data.assets || []);
      }
    } catch {}
  };

  const saveToSwipeFile = async (
    asset: CandidateAsset,
    verdict: SwipeVerdict = 'winner',
    editorNotes?: string
  ): Promise<CandidateAsset | null> => {
    try {
      const res = await apiFetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset, verdict, editorNotes }),
      });
      if (!res.ok) {
        showToast('تعذر حفظ الفيديو في مكتبة Swipe File', 'error');
        return null;
      }
      const data = await res.json();
      const saved: CandidateAsset = data.asset;
      setLibrary((prev) => {
        const filtered = prev.filter((item) => item.id !== saved.id);
        return [saved, ...filtered];
      });
      showToast('تم حفظ الفيديو في مكتبة Swipe File وأرشفته محلياً', 'success');
      return saved;
    } catch {
      showToast('تعذر الاتصال بالخادم لحفظ الفيديو', 'error');
      return null;
    }
  };

  const updateSwipeItem = async (
    assetId: string,
    updates: {
      swipeVerdict?: SwipeVerdict;
      editorNotes?: string;
      creativeAnalysis?: CreativeHookAnalysis;
    }
  ): Promise<CandidateAsset | null> => {
    try {
      const res = await apiFetch(`/api/library/${encodeURIComponent(assetId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const updated: CandidateAsset = data.asset;
      setLibrary((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      return updated;
    } catch {
      return null;
    }
  };

  const removeFromSwipeFile = async (assetId: string): Promise<boolean> => {
    try {
      const res = await apiFetch(`/api/library/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return false;
      setLibrary((prev) => prev.filter((item) => item.id !== assetId));
      showToast('تم إزالة العنصر من مكتبة Swipe File', 'info');
      return true;
    } catch {
      return false;
    }
  };

  const generateCreativeBrief = async (params: {
    productName: string;
    videoTitle?: string;
    platform?: string;
    reviewerOrChannel?: string;
    assetId?: string;
  }): Promise<CreativeHookAnalysis | null> => {
    try {
      const res = await apiFetch('/api/gemini/creative-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        showToast('تعذر توليد تحليل الـ Hooks والسكريبت حالياً', 'error');
        return null;
      }
      const data = await res.json();
      const analysis: CreativeHookAnalysis = data.analysis;
      if (params.assetId) {
        setLibrary((prev) =>
          prev.map((item) =>
            item.id === params.assetId ? { ...item, creativeAnalysis: analysis } : item
          )
        );
        setCurrentProject((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            candidates: prev.candidates.map((c) =>
              c.id === params.assetId ? { ...c, creativeAnalysis: analysis } : c
            ),
          };
        });
      }
      return analysis;
    } catch {
      showToast('تعذر الاتصال بخدمة التحليل الإبداعي', 'error');
      return null;
    }
  };

  const refreshProviders = async () => {
    try {
      const res = await apiFetch('/api/providers');
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers || []);
      }
    } catch {}
  };

  const refreshUsage = async () => {
    try {
      const res = await apiFetch('/api/usage');
      if (res.ok) {
        const data = await res.json();
        setUsage(data);
      }
    } catch {}
  };

  // Initial session check on mount
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

    let mounted = true;
    const checkSession = async () => {
      try {
        const res = await apiFetch('/api/auth/session');
        if (!mounted) return;
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated) {
            setIsAuthenticated(true);
            await Promise.all([refreshProjects(), refreshLibrary()]);
            return;
          }
        }
        setStoredAuthToken(null);
        setAuthTokenState(null);
        setIsAuthenticated(false);
      } catch {
        if (mounted) setIsAuthenticated(false);
      } finally {
        if (mounted) setIsAuthChecking(false);
      }
    };

    checkSession();
    return () => {
      mounted = false;
    };
  }, []);

  // Active Project synchronization: Initial fetch + SSE + Bounded Polling Fallback
  useEffect(() => {
    if (!isAuthenticated || !currentProject?.id || currentProject.id.startsWith('ephemeral-')) return;

    const projectId = currentProject.id;
    let eventSource: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let pollCount = 0;
    const MAX_POLLS = 80; // Bounded fallback (~2 minutes max at 1.5s interval)

    const syncProjectState = (updated: Project) => {
      if (cancelled) return;
      setCurrentProject(updated);
      setProjects((prev) => {
        const exists = prev.some((p) => p.id === updated.id);
        if (!exists) return [updated, ...prev];
        return prev.map((p) => (p.id === updated.id ? updated : p));
      });
      if (isTerminalJobState(updated.jobState) && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const fetchLatestProject = async () => {
      if (cancelled) return;
      try {
        const res = await apiFetch(`/api/projects/${projectId}`);
        if (res.ok && !cancelled) {
          const updated: Project = await res.json();
          syncProjectState(updated);
        }
      } catch {}
    };

    const startBoundedPolling = () => {
      if (pollTimer || cancelled) return;
      pollTimer = setInterval(async () => {
        if (cancelled) return;
        pollCount += 1;
        if (pollCount > MAX_POLLS) {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          return;
        }
        await fetchLatestProject();
      }, 1500);
    };

    // 1. Immediate initial fetch to catch fast completions (e.g. fast 429 or cached media)
    fetchLatestProject();

    // 2. Always run bounded polling while job is in a non-terminal state
    startBoundedPolling();

    // 3. Connect SSE for instant push updates
    const connectSse = async () => {
      try {
        const ticketRes = await apiFetch(`/api/projects/${projectId}/ticket`, { method: 'POST' });
        if (!ticketRes.ok || cancelled) return;
        const { ticket } = await ticketRes.json();
        if (!ticket || cancelled) return;

        eventSource = new EventSource(`/api/events/${projectId}?ticket=${encodeURIComponent(ticket)}`);
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.project) {
              syncProjectState(data.project);
            }
          } catch {}
        };
        eventSource.onerror = () => {
          // Ensure bounded polling continues if SSE drops
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          startBoundedPolling();
        };
      } catch {
        startBoundedPolling();
      }
    };

    connectSse();

    return () => {
      cancelled = true;
      if (eventSource) eventSource.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [isAuthenticated, currentProject?.id]);

  const t = translations[lang];

  return (
    <AppContext.Provider
      value={{
        lang,
        setLang,
        t,
        isAuthenticated,
        isAuthChecking,
        login,
        logout,
        activeTab,
        setActiveTab,
        currentProject,
        setCurrentProject,
        projects,
        refreshProjects,
        library,
        refreshLibrary,
        saveToSwipeFile,
        updateSwipeItem,
        removeFromSwipeFile,
        generateCreativeBrief,
        providers,
        refreshProviders,
        usage,
        refreshUsage,
        isNewSearchOpen,
        setIsNewSearchOpen,
        droppedFile,
        setDroppedFile,
        showToast,
        toast,
        apiFetch,
        fetchMediaBlob,
        downloadWithSession,
        startStreamingSearch,
        acceptRejectedCandidate,
        cancelStreamingSearch,
        autoResolvedProductName,
        sessionId: authToken || '',
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within an AppProvider');
  return context;
};
