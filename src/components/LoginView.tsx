import React, { useState } from 'react';
import { useApp } from '../context/AppContext.tsx';
import { Radar, Lock } from 'lucide-react';

export const LoginView: React.FC = () => {
  const { login } = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = code.trim().toLowerCase();
    if (!normalized) {
      setError('يرجى إدخال كود الدخول');
      return;
    }

    setError(null);
    setIsLoading(true);
    try {
      const result = await login(normalized);
      if (!result.ok) {
        setError(result.error || 'كود الدخول غير صحيح');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen bg-[#F6F7F4] text-[#181B1A] flex flex-col items-center justify-center px-4 py-8 font-sans"
      dir="rtl"
    >
      <div className="w-full max-w-[400px] bg-white rounded-2xl border border-[#E2E5DF] shadow-[0_4px_20px_rgba(0,0,0,0.03)] p-6 sm:p-8 space-y-6">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center gap-2.5">
          <div className="w-12 h-12 rounded-2xl bg-[#247C72] flex items-center justify-center text-white shadow-xs">
            <Radar className="w-6 h-6 stroke-[2.2]" />
          </div>
          <h1
            className="font-extrabold text-xl tracking-tight text-[#181B1A] font-sans"
            dir="ltr"
          >
            Creative <span className="text-[#247C72]">Radaar</span>
          </h1>
        </div>

        {/* Access Code Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="access-code-input"
              className="block text-sm font-semibold text-[#181B1A] mb-2"
            >
              كود الدخول
            </label>
            <div className="relative">
              <input
                id="access-code-input"
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="أدخل كود الدخول..."
                className="w-full h-11 px-4 rounded-xl bg-[#FAFBF9] border border-[#E2E5DF] text-sm text-[#181B1A] placeholder-[#8A908D] focus:outline-none focus:bg-white focus:border-[#247C72] transition-colors"
              />
              <Lock className="w-4 h-4 text-[#8A908D] absolute left-3.5 top-3.5 pointer-events-none" />
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 rounded-xl px-3.5 py-2.5"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-11 rounded-xl bg-[#247C72] hover:bg-[#1E665E] disabled:opacity-60 text-white font-semibold text-sm transition-colors flex items-center justify-center cursor-pointer"
          >
            {isLoading ? 'جاري التحقق...' : 'دخول'}
          </button>
        </form>
      </div>
    </div>
  );
};
