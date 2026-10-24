import React, { useEffect, useState } from 'react';
import { bindFileDragOverlay } from './utils/fileDragOverlay.ts';
import { CustomerReviewsApp } from '../frontend/CustomerReviewsApp';
import { AppProvider, useApp } from './context/AppContext.tsx';
import { Navbar } from './components/Navbar.tsx';
import { LoginView } from './components/LoginView.tsx';
import { ManualLinkModal } from './components/ManualLinkModal.tsx';
import { HomeSearchCard } from './components/HomeSearchCard.tsx';
import { JobProgress } from './components/JobProgress.tsx';
import { ResultsGallery } from './components/ResultsGallery.tsx';
import { ProjectsView } from './components/ProjectsView.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { CheckCircle2, Info, Upload, Loader2 } from 'lucide-react';

const MainContent: React.FC = () => {
  const {
    isAuthenticated,
    isAuthChecking,
    activeTab,
    currentProject,
    toast,
    setDroppedFile,
    setCurrentProject,
    setActiveTab,
    showToast,
  } = useApp();

  const [isWindowDragging, setIsWindowDragging] = useState(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  useEffect(() => { setIsManualModalOpen(false); }, [currentProject?.id]);

  useEffect(() => {
    setIsWindowDragging(false);
    if (!isAuthenticated) return;
    const unbindOverlay = bindFileDragOverlay(window, setIsWindowDragging);

    const handleWindowDrop = (e: DragEvent) => {
      e.preventDefault();

      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('image/')) {
          setCurrentProject(null);
          setActiveTab('search');
          setDroppedFile(file);
        } else {
          showToast('يرجى إفلات ملف صورة صالح (PNG, JPG, WebP)', 'error');
        }
      }
    };

    const handleWindowPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            setCurrentProject(null);
            setActiveTab('search');
            setDroppedFile(file);
            break;
          }
        }
      }
    };

    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('paste', handleWindowPaste);

    return () => {
      unbindOverlay();
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('paste', handleWindowPaste);
    };
  }, [isAuthenticated]);

  if (isAuthChecking) {
    return (
      <div
        className="min-h-screen bg-[#F6F7F4] text-[#181B1A] flex items-center justify-center font-sans"
        dir="rtl"
      >
        <Loader2 className="w-6 h-6 animate-spin text-[#247C72]" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginView />;
  }

  return (
    <div className="min-h-screen bg-[#F6F7F4] text-[#181B1A] flex flex-col font-sans relative" dir="rtl">
      {isWindowDragging && !currentProject && activeTab === 'search' && (
        <div className="fixed inset-0 z-50 bg-[#181B1A]/60 backdrop-blur-xs flex flex-col items-center justify-center p-6 pointer-events-none">
          <div className="border-2 border-dashed border-[#247C72] bg-white rounded-2xl p-8 max-w-md w-full text-center shadow-xl flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-[#EAF3F2] text-[#247C72] flex items-center justify-center">
              <Upload className="w-6 h-6" />
            </div>
            <p className="text-base font-bold text-[#181B1A]">
              أفلت صورة المنتج هنا
            </p>
          </div>
        </div>
      )}

      <Navbar />

      <main className="flex-1 max-w-[760px] w-full mx-auto px-4 py-6 sm:py-8">
        {activeTab === 'search' ? (
          !currentProject ? (
            <HomeSearchCard />
          ) : (
            <div className="space-y-4">
              <JobProgress
                key={currentProject.id}
                project={currentProject}
                onOpenManualModal={() => setIsManualModalOpen(true)}
              />
              <ResultsGallery key={currentProject.id} project={currentProject} />
            </div>
          )
        ) : (
          <ProjectsView />
        )}
      </main>

      <ManualLinkModal
        key={currentProject?.id || 'new'}
        isOpen={isManualModalOpen}
        onClose={() => setIsManualModalOpen(false)}
        projectId={currentProject?.id}
      />

      {toast && (
        <div className="fixed bottom-5 left-5 z-50">
          <div
            className={`flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg border text-xs font-bold ${
              toast.type === 'success'
                ? 'bg-emerald-950 text-emerald-100 border-emerald-800'
                : toast.type === 'error'
                ? 'bg-rose-950 text-rose-100 border-rose-800'
                : toast.type === 'warn'
                ? 'bg-amber-950 text-amber-100 border-amber-800'
                : 'bg-[#181B1A] text-white border-[#333]'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Info className="w-4 h-4 text-[#247C72]" />
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default function App() {
  if (import.meta.env.VITE_REVIEWS_API_URL) return <ErrorBoundary><CustomerReviewsApp api={import.meta.env.VITE_REVIEWS_API_URL.replace(/\/$/,'')} /></ErrorBoundary>;
  return (
    <ErrorBoundary>
      <AppProvider>
        <MainContent />
      </AppProvider>
    </ErrorBoundary>
  );
}
