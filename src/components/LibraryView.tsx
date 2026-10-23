import React, { useState } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { CandidateAsset } from '../types/index.ts';
import { AssetCard } from './AssetCard.tsx';
import { AssetPreviewModal } from './AssetPreviewModal.tsx';
import { Film, Search, Filter, Video, Camera } from 'lucide-react';

export const LibraryView: React.FC = () => {
  const { library } = useApp();
  const [searchTerm, setSearchTerm] = useState('');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'video' | 'photo'>('all');
  const [previewingAsset, setPreviewingAsset] = useState<CandidateAsset | null>(null);

  const filteredAssets = library.filter((asset) => {
    if (mediaFilter !== 'all' && asset.mediaType !== mediaFilter) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchTitle = asset.title.toLowerCase().includes(q);
      const matchDesc = asset.contentDescription.toLowerCase().includes(q);
      const matchReviewer = (asset.reviewerOrChannel || '').toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchReviewer) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 tracking-tight">مكتبة الوسائط المعتمدة</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            جميع فيديوهات وصور العملاء الموثقة والمطابقة عبر كل مشاريع مساحة العمل
          </p>
        </div>

        {/* Search & Filter */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="بحث في العناوين والوصف..."
              className="pr-9 pl-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-white focus:border-teal-500 focus:outline-hidden w-56"
            />
          </div>

          <div className="flex items-center rounded-xl bg-slate-100 p-0.5 border border-slate-200 text-xs">
            <button
              onClick={() => setMediaFilter('all')}
              className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                mediaFilter === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              الكل ({library.length})
            </button>
            <button
              onClick={() => setMediaFilter('video')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-bold transition-all ${
                mediaFilter === 'video' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <Video className="w-3 h-3" />
              <span>فيديوهات</span>
            </button>
            <button
              onClick={() => setMediaFilter('photo')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-bold transition-all ${
                mediaFilter === 'photo' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              <Camera className="w-3 h-3" />
              <span>صور</span>
            </button>
          </div>
        </div>
      </div>

      {/* Grid */}
      {filteredAssets.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredAssets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onPreview={(a) => setPreviewingAsset(a)}
              onToggleSelect={() => {}}
            />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <Film className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <h3 className="font-bold text-slate-800 text-base mb-1">المكتبة فارغة حاليًا</h3>
          <p className="text-xs text-slate-500">
            أي أصول يتم التحقق من مطابقتها وتنزيلها ستظهر هنا تلقائيًا لإعادة استخدامها عبر المشاريع.
          </p>
        </div>
      )}

      {/* Preview Modal */}
      <AssetPreviewModal
        asset={previewingAsset}
        onClose={() => setPreviewingAsset(null)}
      />
    </div>
  );
};
