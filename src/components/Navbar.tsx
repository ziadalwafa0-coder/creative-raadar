import React from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Compass, FolderKanban, Radar, LogOut } from 'lucide-react';

export const Navbar: React.FC = () => {
  const { activeTab, setActiveTab, currentProject, setCurrentProject, projects, logout } = useApp();

  const handleNewSearchClick = () => {
    setCurrentProject(null);
    setActiveTab('search');
  };

  const handleProjectsClick = () => {
    setActiveTab('projects');
  };

  const isSearchActive = activeTab === 'search' && !currentProject;
  const isProjectsActive = activeTab === 'projects';

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200/80">
      <div className="max-w-[760px] mx-auto px-2.5 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-1.5">
        {/* Brand Logo: Creative Radaar */}
        <button
          type="button"
          onClick={handleNewSearchClick}
          className="flex items-center gap-1.5 sm:gap-2 text-right cursor-pointer focus:outline-hidden group shrink-0"
        >
          <div className="w-7 h-7 sm:w-9 sm:h-9 rounded-xl bg-[#247C72] flex items-center justify-center text-white shadow-xs group-hover:bg-[#1d665d] transition-colors shrink-0">
            <Radar className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.2]" />
          </div>
          <span
            className="font-extrabold text-xs sm:text-lg tracking-tight text-slate-900 font-sans whitespace-nowrap"
            dir="ltr"
          >
            Creative <span className="text-[#247C72]">Radaar</span>
          </span>
        </button>

        {/* Navigation Tabs + Logout */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <nav className="flex items-center gap-0.5 sm:gap-1 bg-[#F6F7F4] p-0.5 sm:p-1 rounded-xl border border-slate-200/80 shrink-0">
            <button
              type="button"
              onClick={handleNewSearchClick}
              className={`flex items-center gap-1.5 px-2 sm:px-3.5 py-1.5 rounded-lg text-[11px] sm:text-sm font-bold whitespace-nowrap transition-all cursor-pointer ${
                isSearchActive
                  ? 'bg-[#247C72] text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Compass className="hidden sm:inline-block w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
              <span>بحث جديد</span>
            </button>

            <button
              type="button"
              onClick={handleProjectsClick}
              className={`flex items-center gap-1 px-2 sm:px-3.5 py-1.5 rounded-lg text-[11px] sm:text-sm font-bold whitespace-nowrap transition-all cursor-pointer ${
                isProjectsActive
                  ? 'bg-[#247C72] text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FolderKanban className="hidden sm:inline-block w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
              <span>مشاريعي</span>
              {projects.length > 0 && (
                <span
                  className={`text-[10px] sm:text-[11px] font-bold px-1.5 py-0.2 rounded-full ${
                    isProjectsActive
                      ? 'bg-white/20 text-white'
                      : 'bg-slate-200/90 text-slate-700'
                  }`}
                >
                  {projects.length}
                </span>
              )}
            </button>
          </nav>

          <button
            type="button"
            onClick={logout}
            title="خروج"
            className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 sm:py-2 rounded-xl border border-[#E2E5DF] bg-white hover:bg-[#FAFBF9] text-[#616764] hover:text-red-600 text-[11px] sm:text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer"
          >
            <LogOut className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
            <span>خروج</span>
          </button>
        </div>
      </div>
    </header>
  );
};
