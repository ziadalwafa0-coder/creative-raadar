import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Language, translations } from '../translations/index.ts';
import { Project, CandidateAsset, ProviderCapability, WorkspaceUsage } from '../types/index.ts';

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
  downloadWithSession: (url: string, fallbackFilename: string) => Promise<boolean>;
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
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'warn' | 'error' } | null>(null);

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
      await refreshProjects();
      return { ok: true };
    } catch {
      return { ok: false, error: 'تعذر الاتصال بالخادم. يرجى المحاولة مرة أخرى.' };
    }
  };

  const logout = async (): Promise<void> => {
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

  const downloadWithSession = async (url: string, fallbackFilename: string): Promise<boolean> => {
    try {
      const res = await apiFetch(url);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();

      if (!res.ok || contentType.includes('application/json')) {
        const errPayload = await res.json().catch(() => ({ error: 'تعذر تنزيل الملف المطلوب' }));
        showToast(errPayload.error || 'تعذر تنزيل الملف المطلوب', 'error');
        return false;
      }

      let filename = fallbackFilename;
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
        showToast('الملف المستلم فارغ', 'error');
        return false;
      }

      const blobUrl = URL.createObjectURL(blob);
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
    } catch (err) {
      console.error('[Download Error]', err);
      showToast('حدث خطأ أثناء الاتصال بالخادم لتنزيل الملف', 'error');
      return false;
    }
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
        setCurrentProject((prev) =>
          prev ? list.find((p) => p.id === prev.id) || prev : null
        );
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
            await refreshProjects();
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
    if (!isAuthenticated || !currentProject?.id) return;

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
        downloadWithSession,
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
