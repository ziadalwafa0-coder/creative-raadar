import fs from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch } from 'undici';
import type { ProvenanceClassification } from '../types/index.ts';
import { DATA_DIR } from './config.ts';
import {
  amazonUndiciAgent,
  AMAZON_CHROME_USER_AGENT,
  fetchAmazonHtml,
  AmazonBlockError,
} from './amazonHttp.ts';
import { extractAsinFromUrl } from './queryBuilder.ts';

export interface ExtractedAmazonVideo {
  reviewStars?: number;
  title: string;
  mediaUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  sourceUrl: string;
  productListingUrl?: string;
  reviewerOrChannel: string;
  reviewId: string;
  streamUuid: string;
  provenance: ProvenanceClassification;
  isCustomerReview: boolean;
  incentiveDisclosure?: string;
  contentDescription: string;
  durationSeconds?: number;
}

interface AsinVideoCacheEntry {
  resumePage?:number;
  asin: string;
  videos: ExtractedAmazonVideo[];
  isNegative: boolean;
  cachedAt: number;
  expiresAt: number;
  exhausted?: boolean;
}

const ASIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours TTL (positive & negative cache)
const ASIN_CACHE_FILE = path.join(DATA_DIR, 'amazon_asin_videos_cache_v5.json');
const asinVideoCache = new Map<string, AsinVideoCacheEntry>();

function loadAsinCacheFromDisk(): void {
  try {
    if (fs.existsSync(ASIN_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ASIN_CACHE_FILE, 'utf-8'));
      const now = Date.now();
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item?.asin && Array.isArray(item.videos) && item.expiresAt > now) {
            asinVideoCache.set(item.asin, item);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[AmazonVideoCache] Failed to load ASIN video cache:', (err as Error)?.message);
  }
}

function saveAsinCacheToDisk(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const now = Date.now();
    const active: AsinVideoCacheEntry[] = [];
    for (const [k, v] of asinVideoCache.entries()) {
      if (v.expiresAt > now) active.push(v);
      else asinVideoCache.delete(k);
    }
    fs.writeFileSync(ASIN_CACHE_FILE, JSON.stringify(active, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[AmazonVideoCache] Failed to save ASIN video cache:', (err as Error)?.message);
  }
}

loadAsinCacheFromDisk();

function decodeEntities(str: string): string {
  return (str || '')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/gi, "'")
    .replace(/&amp;|\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .trim();
}

export function extractStreamUuid(videoUrl: string): string {
  const clean = decodeEntities(videoUrl).split('?')[0];
  const m = clean.match(/vse-vms-transcoding-artifact[^/]*\/([a-z0-9_-]{6,64})\//i);
  if (m) return m[1].toLowerCase();
  const tail = clean.match(/\/([A-Za-z0-9_-]{10,})\.(?:m3u8|mp4)$/i);
  return tail ? tail[1].toLowerCase() : clean.toLowerCase();
}

export function selectHighestQualityVariantFromM3u8(
  masterM3u8Content: string,
  masterUrl: string
): string | null {
  const lines = masterM3u8Content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let bestBandwidth = -1;
  let bestVariantUrl: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/AVERAGE-BANDWIDTH=(\d+)/i) || line.match(/BANDWIDTH=(\d+)/i);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        try {
          const resolved = new URL(nextLine, masterUrl).href;
          if (bw >= bestBandwidth) {
            bestBandwidth = bw;
            bestVariantUrl = resolved;
          }
        } catch (err) {
          console.warn('[M3u8Parse] Invalid variant URL:', (err as Error)?.message);
        }
      }
    }
  }
  return bestVariantUrl;
}

async function confirmMp4ByHead(candidateUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeoutSig = AbortSignal.timeout(2500);
    const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await undiciFetch(candidateUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': AMAZON_CHROME_USER_AGENT },
      dispatcher: amazonUndiciAgent,
      signal: combinedSig,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const len = Number(res.headers.get('content-length') || 0);
    if (res.ok && (ct.includes('video') || ct.includes('mp4') || ct.includes('octet-stream')) && len > 10_000) {
      return candidateUrl;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveBestVideoDownloadUrl(
  rawVideoUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const cleanUrl = decodeEntities(rawVideoUrl);
  if (/\.mp4(?:[?#]|$)/i.test(cleanUrl)) {
    const confirmed = await confirmMp4ByHead(cleanUrl, signal);
    if (confirmed) return confirmed;
  }

  const mp4Candidates: string[] = [];
  if (cleanUrl.includes('vse-vms-transcoding-artifact')) {
    const baseDir = cleanUrl.replace(/\/[^/]+\.m3u8.*$/i, '');
    mp4Candidates.push(
      `${baseDir}/default.jobtemplate.mp4.480.mp4`,
      `${baseDir}/default.vertical.jobtemplate.mp4.480.mp4`
    );
  }

  const [headResults, m3u8Variant] = await Promise.all([
    Promise.all(mp4Candidates.map((c) => confirmMp4ByHead(c, signal))),
    (async (): Promise<string | null> => {
      if (!/\.m3u8(?:[?#]|$)/i.test(cleanUrl)) return null;
      try {
        const timeoutSig = AbortSignal.timeout(3000);
        const combinedSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
        const res = await undiciFetch(cleanUrl, {
          method: 'GET',
          headers: { 'User-Agent': AMAZON_CHROME_USER_AGENT },
          dispatcher: amazonUndiciAgent,
          signal: combinedSig,
        });
        if (!res.ok) return null;
        const text = await res.text();
        return selectHighestQualityVariantFromM3u8(text, cleanUrl);
      } catch {
        return null;
      }
    })(),
  ]);

  return headResults.find(Boolean) || m3u8Variant || cleanUrl;
}

export function parseAmazonUsVideosFromHtml(
  html: string,
  pageUrl: string
): ExtractedAmazonVideo[] {
  const targetAsin = extractAsinFromUrl(pageUrl);
  const results: ExtractedAmazonVideo[] = [];
  const seenUuids = new Set<string>();

  const pushCandidate = (item: {
    videoUrl: string;
    reviewStars?: number;
    title?: string;
    reviewer?: string;
    thumb?: string;
    reviewLink?: string;
    creatorType?: string;
    segmentName?: string;
    productAsin?: string;
    parentAsin?: string;
    relatedAsins?: string;
    isCustomerSection?: boolean;
  }) => {
    const rawUrl = decodeEntities(item.videoUrl || '');
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl) || !/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(rawUrl)) return;

    const segLower = (item.segmentName || '').toLowerCase();
    if (segLower.includes('related product') || segLower.includes('other product')) return;

    const relatedList: string[] = (item.relatedAsins || '').toUpperCase().match(/\b[B0-9][A-Z0-9]{9}\b/g) || [];
    if (relatedList.length > 2) return;

    const vAsin = (item.productAsin || '').trim().toUpperCase();
    // A recommendation must not expand the allowed product family for the rest
    // of the page. Require an explicit connection to the inspected product.
    if (!targetAsin) return;
    if (vAsin && vAsin !== targetAsin) return;
    if (relatedList.length && !relatedList.includes(targetAsin)) return;
    if (!vAsin && !relatedList.includes(targetAsin) && !item.isCustomerSection) return;

    const cType = (item.creatorType || '').toLowerCase();
    let hasCustomerReviewLink=false;
    try{
      const link=new URL(item.reviewLink||'', 'https://www.amazon.com');
      hasCustomerReviewLink=link.protocol==='https:' && ['www.amazon.com','amazon.com'].includes(link.hostname)
        && !link.username && !link.password && !link.port && /^\/(?:gp\/)?customer-reviews\/R[A-Z0-9]+(?:\/|$)/i.test(link.pathname);
    }catch{ /* An invalid link is not evidence of a customer review. */ }
    const isSellerOrInfluencer = /seller|vendor|brand|manufacturer|influencer|merchant|affiliate/.test(cType);
    if (isSellerOrInfluencer) return;

    const isCustomer = hasCustomerReviewLink || Boolean(item.isCustomerSection);
    if (!isCustomer) return;

    const streamUuid = extractStreamUuid(rawUrl);
    if (seenUuids.has(streamUuid)) return;
    seenUuids.add(streamUuid);

    let reviewId = `amz-${streamUuid.slice(0, 16)}`;
    const revMatch = (item.reviewLink || '').match(/customer-reviews\/([A-Z0-9]+)/i);
    if (revMatch && revMatch[1].toUpperCase() !== targetAsin) {
      reviewId = revMatch[1].toUpperCase();
    }

    const cleanTitle = decodeEntities(item.title || '').replace(/\s+/g, ' ').trim() || 'مراجعة عميل أمازون';
    const cleanReviewer = decodeEntities(item.reviewer || '').replace(/\s+/g, ' ').trim() || 'عميل أمازون';
    const fullSourceUrl = item.reviewLink
      ? item.reviewLink.startsWith('http')
        ? item.reviewLink
        : `https://www.amazon.com${item.reviewLink.startsWith('/') ? '' : '/'}${item.reviewLink}`
      : pageUrl;

    results.push({
      title: cleanTitle,
      reviewStars:item.reviewStars,
      mediaUrl: rawUrl,
      downloadUrl: rawUrl,
      thumbnailUrl: item.thumb ? decodeEntities(item.thumb) : undefined,
      sourceUrl: fullSourceUrl,
      productListingUrl: pageUrl,
      reviewerOrChannel: cleanReviewer,
      reviewId,
      streamUuid,
      provenance: 'unverified_customer_review',
      isCustomerReview: true,
      incentiveDisclosure: undefined,
      contentDescription: cleanTitle,
    });
  };

  const attrRegex = /data-video-items="(\[[\s\S]*?\])"/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(html)) !== null) {
    const objBlocks = attrMatch[1].match(/\{[^{}]*\}/g) || [];
    for (const rawObj of objBlocks) {
      const decoded = rawObj.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&amp;/g, '&');
      const getField = (name: string): string => {
        const m = decoded.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
        return m ? decodeEntities(m[1]) : '';
      };
      const videoUrl = getField('videoURL') || getField('url') || getField('hlsUrl');
      if (videoUrl) {
        pushCandidate({
          videoUrl,
          title: getField('title') || getField('reviewTitle'),
          reviewer: getField('publicName') || getField('profileName') || getField('creatorName'),
          thumb: getField('slateUrl') || getField('thumbnailUrl') || getField('imageUrl'),
          reviewLink: getField('fullReviewLink') || getField('reviewUrl'),
          creatorType: getField('creatorType') || getField('type'),
          segmentName: getField('segmentName'),
          productAsin: getField('productAsin') || getField('asin'),
          parentAsin: getField('parentAsin'),
          relatedAsins: getField('relatedProductsAsins'),
        });
      }
    }
  }

  const reviewBlockRegex = /<div\b[^>]*\bid="customer_review-([A-Z0-9]+)"[^>]*>/gi;
  let revBlockMatch: RegExpExecArray | null;
  while ((revBlockMatch = reviewBlockRegex.exec(html)) !== null) {
    const reviewId = revBlockMatch[1];
    // Bound the last review to its actual closing element, not the page footer
    // (which may contain videos for completely unrelated recommendations).
    const bodyStart = reviewBlockRegex.lastIndex;
    const divTags = /<\/?div\b[^>]*>/gi;
    divTags.lastIndex = bodyStart;
    let depth = 1;
    let closeAt = -1;
    let divTag: RegExpExecArray | null;
    while ((divTag = divTags.exec(html)) !== null) {
      depth += /^<\/div/i.test(divTag[0]) ? -1 : 1;
      if (depth === 0) { closeAt = divTag.index; break; }
    }
    if (closeAt < 0) continue;
    const block = html.slice(bodyStart, closeAt);
    reviewBlockRegex.lastIndex = divTags.lastIndex;
    const urlMatches = block.matchAll(
      /(https?:\/\/m\.media-amazon\.com\/images\/S\/vse-vms-transcoding-artifact[^"'\s\\]+\.(?:m3u8|mp4))/gi
    );
    const titleMatch =
      block.match(/data-hook="review-title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ||
      block.match(/class="[^"]*review-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const profileMatch = block.match(/class="a-profile-name"[^>]*>([\s\S]*?)<\/span>/i);
    const thumbMatch = block.match(/<video\b[^>]*\bposter="(https:\/\/[^"]+)"/i);

    for (const um of urlMatches) {
      pushCandidate({
        videoUrl: um[1],
        reviewStars: Number(block.match(/data-hook="(?:review-star-rating|cmps-review-star-rating)"[^>]*>[\s\S]{0,180}?([1-5])(?:\.0)? out of 5/i)?.[1]) || undefined,
        title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'مراجعة فيديو من مشتري',
        reviewer: profileMatch ? profileMatch[1].replace(/<[^>]+>/g, '').trim() : 'عميل أمازون',
        thumb: thumbMatch ? thumbMatch[1] : undefined,
        reviewLink: `/gp/customer-reviews/${reviewId}`,
        creatorType: 'Customer',
        productAsin: targetAsin || undefined,
        isCustomerSection: true,
      });
    }
  }

  return results;
}

export async function fetchAmazonUsProductVideos(
  productUrlOrAsin: string,
  signal?: AbortSignal,
  options: {resume?:boolean;limit?:number; excludeStreamUuids?:Set<string>; shouldStop?:()=>boolean; onVideo?:(video:ExtractedAmazonVideo)=>void; onLimited?:(reason:string)=>void; fetchHtml?:typeof fetchAmazonHtml} = {}
): Promise<ExtractedAmazonVideo[]> {
  const asin = extractAsinFromUrl(productUrlOrAsin) || productUrlOrAsin.trim().toUpperCase();
  const isAsinValid = /^[B0-9][A-Z0-9]{9}$/.test(asin);
  const now = Date.now();
  const limit = Math.min(500, Math.max(1, options.limit || 50));
  signal?.throwIfAborted();
  const fetchHtml = options.fetchHtml || fetchAmazonHtml;
  const cached = isAsinValid && !options.fetchHtml ? asinVideoCache.get(asin) : undefined;

  if (isAsinValid) {
    const available=cached?.videos.filter(video=>!options.excludeStreamUuids?.has(video.streamUuid)) || [];
    if (!options.fetchHtml && cached && cached.expiresAt > now && (available.length >= limit || cached.exhausted)) {
      const videos = available.slice(0,limit);
      videos.forEach(video=>options.onVideo?.(video));
      return videos;
    }
  }

  const dpUrl = isAsinValid ? `https://www.amazon.com/dp/${asin}` : productUrlOrAsin;
  let resumePage=options.resume&&cached&&cached.expiresAt>now?cached.resumePage||1:1;
  const reviewsMediaUrl = isAsinValid
    ? `https://www.amazon.com/product-reviews/${asin}?mediaType=media_reviews_only${resumePage>1?'&pageNumber='+resumePage:''}`
    : null;

  let limited=false;
  const report=(reason:string)=>{limited=true;options.onLimited?.(reason);};
  const reportFailure=(error:unknown)=>{
    if(!(error instanceof AmazonBlockError))return report('تعذّر الاتصال بإحدى صفحات أمازون.');
    if(/sign-in required/i.test(error.message))return report('أمازون طلب تسجيل الدخول لقراءة صفحة المراجعات.');
    if(/captcha|robot check/i.test(error.message))return report('أمازون طلب التحقق قبل عرض الصفحة.');
    if(error.status===429)return report('أمازون حدّ عدد الطلبات مؤقتًا.');
    if(error.status===403)return report('أمازون رفض الوصول إلى الصفحة.');
    if(error.status===503)return report('إحدى صفحات أمازون لم تكن متاحة وقت البحث.');
    report('تعذّرت قراءة محتوى إحدى صفحات أمازون.');
  };
  let blockError: AmazonBlockError | null = null;
  const [dpHtml, reviewsHtml] = await Promise.all([
    fetchHtml(dpUrl, { signal, timeoutMs: 8000, minHtmlChars: 4000, referer: 'https://www.amazon.com/' }).catch((err: unknown) => {
      reportFailure(err);
      if (err instanceof AmazonBlockError) blockError = err;
      console.warn(`[AmazonVideos] Product page fetch error (${dpUrl}):`, (err as Error)?.message || err);
      return '';
    }),
    reviewsMediaUrl
      ? fetchHtml(reviewsMediaUrl, { signal, timeoutMs: 8000, minHtmlChars: 2500, referer: dpUrl }).catch((err: unknown) => {
          reportFailure(err);
          if (err instanceof AmazonBlockError && !blockError) blockError = err;
          console.warn(`[AmazonVideos] Media reviews fetch error (${reviewsMediaUrl}):`, (err as Error)?.message || err);
          return '';
        })
      : Promise.resolve(''),
  ]);

  if (!dpHtml && !reviewsHtml && blockError && !(cached && cached.expiresAt>now && cached.videos.length)) throw blockError;

  const fromDp = dpHtml ? parseAmazonUsVideosFromHtml(dpHtml, dpUrl) : [];
  const fromReviews = reviewsHtml && reviewsMediaUrl ? parseAmazonUsVideosFromHtml(reviewsHtml, dpUrl) : [];

  const mergedByUuid = new Map<string, ExtractedAmazonVideo>();
  if (cached && cached.expiresAt > now) for (const video of cached.videos) mergedByUuid.set(video.streamUuid,video);
  for (const v of [...fromReviews, ...fromDp]) {
    if (!mergedByUuid.has(v.streamUuid)) mergedByUuid.set(v.streamUuid, v);
  }
  const delivered = new Set<string>();
  const deliver = async () => {
    while(delivered.size<limit && !options.shouldStop?.()) {
      const slice = Array.from(mergedByUuid.values()).filter(video=>!delivered.has(video.streamUuid) && !options.excludeStreamUuids?.has(video.streamUuid)).slice(0,Math.min(6,limit-delivered.size));
      if (!slice.length) break;
      signal?.throwIfAborted();
    await Promise.all(
      slice.map(async (v) => {
        if (!options.fetchHtml) v.downloadUrl = await resolveBestVideoDownloadUrl(v.mediaUrl, signal);
        if (options.excludeStreamUuids?.has(v.streamUuid)) return;
        delivered.add(v.streamUuid); options.onVideo?.(v);
      })
    );
    }
  };
  await deliver();
  let exhausted = Boolean(reviewsHtml) && !nextAmazonReviewPage(reviewsHtml,dpUrl,asin);
  let html = reviewsHtml;
  const visited = new Set<string>();
  const pageBudget=Math.max(10,Math.min(50,Math.ceil(limit/4)));
  for (let page = 1; html && delivered.size < limit && !options.shouldStop?.() && page < pageBudget; page++) {
    signal?.throwIfAborted();
    const next = nextAmazonReviewPage(html, dpUrl, asin);
    if (!next) break;
    if (visited.has(next)) { exhausted=false; report('كررت أمازون نفس صفحة المراجعات.'); break; }
    visited.add(next); exhausted=false;
    resumePage=Number(new URL(next).searchParams.get('pageNumber'))||resumePage;

    try {
      html = await fetchHtml(next,{signal,timeoutMs:8000,minHtmlChars:2500,referer:dpUrl});
      const videos = parseAmazonUsVideosFromHtml(html,dpUrl);
      for (const video of videos) if (!mergedByUuid.has(video.streamUuid)) mergedByUuid.set(video.streamUuid,video);
      // Image-only and duplicate-only pages may still link to more video reviews.
      await deliver(); exhausted=!nextAmazonReviewPage(html,dpUrl,asin);
    } catch (error) { signal?.throwIfAborted(); reportFailure(error); break; }
  }
  // Amazon's public product carousel can return a different subset on each view.
  // Merge a bounded number of ordinary successful page reads; never retry a block.
  const carouselBudget=Math.max(3,Math.min(12,Math.ceil(limit/10)));
  let unchangedViews=0;
  for (let view=0; dpHtml && delivered.size<limit && !options.shouldStop?.() && view<carouselBudget;view++) {
    signal?.throwIfAborted();
    exhausted=false;
    try {
      const snapshot=await fetchHtml(dpUrl,{signal,timeoutMs:8000,minHtmlChars:4000,referer:dpUrl});
      const before=mergedByUuid.size;
      for(const video of parseAmazonUsVideosFromHtml(snapshot,dpUrl)) if(!mergedByUuid.has(video.streamUuid)) mergedByUuid.set(video.streamUuid,video);
      unchangedViews=before===mergedByUuid.size ? unchangedViews+1 : 0;
      await deliver();
      if(unchangedViews>=2) break;
    } catch(error) { signal?.throwIfAborted(); reportFailure(error); break; }
  }
  const merged = Array.from(mergedByUuid.values());

  if (isAsinValid && !signal?.aborted && !options.fetchHtml) {
    asinVideoCache.set(asin, {
      asin,
      videos: merged,
      isNegative: merged.length === 0,
      cachedAt: now,
      expiresAt: now + ASIN_CACHE_TTL_MS,
      resumePage,exhausted:exhausted&&!limited,
    });
    saveAsinCacheToDisk();
  }

  return merged.filter(video=>delivered.has(video.streamUuid)).slice(0,limit);
}

export function nextAmazonReviewPage(html:string, baseUrl:string, asin:string):string | null {
  const block = html.match(/<li\b[^>]*class=["'][^"']*a-last[^"']*["'][^>]*>[\s\S]*?<\/li>/i)?.[0];
  if (!block || /a-disabled/i.test(block)) return null;
  const href = block.match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href),baseUrl);
    if (url.protocol !== 'https:' || !['amazon.com','www.amazon.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    const parts=url.pathname.split('/').filter(Boolean);
    const pos=parts.indexOf('product-reviews');
    if(pos<0 || pos>1 || parts[pos+1]!==asin || parts.slice(pos+2).some((part,i)=>i!==0||!/^ref=[a-z0-9_-]+$/i.test(part)))return null;
    url.searchParams.set('mediaType','media_reviews_only');
    return url.href;
  } catch { return null; }
}
