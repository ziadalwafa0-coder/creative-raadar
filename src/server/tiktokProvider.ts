type TikTokVideo = {url:string;source:string;title:string;author:string};

export function parseTikTokProviderRows(rows:unknown,limit:number):TikTokVideo[] {
  if (!Array.isArray(rows)) return [];
  const videos:TikTokVideo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || row.isSlideshow || !/^\d{12,24}$/.test(String(row.id))) continue;
    let source:URL;
    try { source = new URL(row.webVideoUrl); } catch { continue; }
    if (source.origin !== 'https://www.tiktok.com' || !new RegExp('^/@[-\\w.]+/video/'+row.id+'$').test(source.pathname)) continue;
    const urls = [...(Array.isArray(row.mediaUrls) ? row.mediaUrls : []),row.videoMeta?.downloadAddr,row.videoMeta?.playAddr];
    const media = urls.find((value:unknown)=>{
      try {
        const u = new URL(String(value));
        const cdn = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokv\.com)$/.test(u.hostname);
        const record = u.hostname === 'api.apify.com' && /^\/v2\/key-value-stores\/[a-zA-Z0-9_-]+\/records\/[a-zA-Z0-9._-]+\.mp4$/.test(u.pathname) && !u.search;
        return u.protocol === 'https:' && !u.username && !u.password && !u.port && (cdn || record);
      } catch { return false; }
    });
    if (!media || seen.has(String(row.id))) continue;
    seen.add(String(row.id));
    videos.push({url:media,source:source.href,title:String(row.text || 'فيديو TikTok').slice(0,500),author:String(row.authorMeta?.name || '').slice(0,100)});
    if (videos.length >= limit) break;
  }
  return videos;
}

export async function searchTikTokProvider(query:string,limit:number,signal:AbortSignal,request=fetch,token=process.env.APIFY_API_TOKEN?.trim()):Promise<TikTokVideo[]> {
  if (!token) throw new Error('بحث TikTok يحتاج إعداد مصدر الجلب. أضف APIFY_API_TOKEN لحساب Apify المجاني في إعدادات السيرفر.');
  const headers = {Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const account = await request('https://api.apify.com/v2/users/me',{headers,signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  if (!account.ok) throw new Error('تعذّر التحقق من حساب مصدر TikTok.');
  const user = (await account.json()).data;
  if (user?.plan?.tier !== 'FREE' || user.plan.monthlyBasePriceUsd !== 0 || user.isPaying === true || user.plan.isPayingCustomer === true) {
    throw new Error('مصدر TikTok مضبوط لحساب Apify بالخطة المجانية فقط.');
  }
  const count = Math.min(50,Math.max(1,Math.floor(limit)));
  const response = await request('https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items?timeout=100&maxItems='+count+'&maxTotalChargeUsd=0.1',{
    method:'POST',headers,signal:AbortSignal.any([signal,AbortSignal.timeout(115000)]),
    body:JSON.stringify({searchQueries:[query.slice(0,160)],resultsPerPage:count,searchSection:'/video',shouldDownloadVideos:true,shouldDownloadCovers:false,shouldDownloadSlideshowImages:false})
  });
  if (!response.ok) throw new Error(response.status === 402 ? 'رصيد TikTok المجاني غير كافٍ حاليًا.' : 'تعذّر جلب فيديوهات TikTok من المصدر.');
  return parseTikTokProviderRows(await response.json(),count);
}
