# Feasibility & Reachability Report (`FEASIBILITY.md`)

**Date:** 2026-11-03  
**Environment:** Linux container (`Node.js v22.23.3`, `ffmpeg` installed, `playwright-cli` + headless Chromium installed)

---

## 1. TikTok Video Discovery & Stream Extraction Spike

We executed live network probes from the container against 5 TikTok discovery/hydration mechanisms for `"Photocatalyst Mosquito Killer"` / `"Mosquito Killer Lamp USB"` / `"Suction Mosquito Trap"`:

| Mechanism | Target Endpoint | HTTP Status | Latency (ms) | Payload Size | Outcome / Measured Yield |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **1. Direct TikTok Web Search** | `https://www.tiktok.com/search/video?q=...` | `200` | `309 ms` | `359,318 B` | `seo.abtest.vidList: []` — returns JS challenge shell (`hasCaptcha: true`) without server-rendered video cards when requested without signed browser tokens. |
| **2. Direct TikTok Hashtag Page** | `https://www.tiktok.com/tag/mosquitokiller` | `200` | `281 ms` | `363,904 B` | `seo.abtest.vidList: []` — requires client-side hydration / anti-bot verification. |
| **3. SERP Indexing (`naver` + `bing` RSS) + Direct Video Page Hydration** | `search.naver.com` + `bing.com/search?format=rss` (`site:tiktok.com`) $\rightarrow$ `tiktok.com/@user/video/:id` | `200` | `2,263 ms` | `~280 KB / video` | **WORKS RELIABLY**: Discovered **28 unique TikTok video URLs** in `2.26s`. Fetching individual `@user/video/:id` pages returns `__UNIVERSAL_DATA_FOR_REHYDRATION__` (`webapp.video-detail.itemInfo.itemStruct`) with direct `playAddr` MP4 stream, `originCover`, caption, author stats, and `tt_chain_token` cookies (`hasPlayAddr: true, hasThumb: true`). |
| **4. TikTok oEmbed API** | `https://www.tiktok.com/oembed?url=...` | `200` | `190 ms` | `1.1 KB` | **WORKS RELIABLY**: Returns official metadata (`title`, `author_name`, `thumbnail_url`, `embed_product_id`) for any canonical video URL. |
| **5. Playwright Headless Chromium** | Headless Chromium (`playwright`) | `200` | `4,800 ms` | N/A | Available as a feature-flagged fallback provider (`playwright`) behind a per-provider circuit breaker (`15s` timeout, max 2 pages). |

### Selected TikTok Architecture (Phase E: `src/server/sources/tiktok/*`)
We implement the pluggable `TikTokProvider` interface (`search(identity, opts, signal): AsyncIterable<VideoCandidate>`) configured via `TIKTOK_PROVIDERS` (default `url-import,serp-hydration,playwright`) with a per-provider circuit breaker:
1. **`url-import` (`UrlImportTikTokProvider`)**: Hydrates direct TikTok video URLs (`tiktok.com/@user/video/...`) pasted by the user via `__UNIVERSAL_DATA_FOR_REHYDRATION__` + `oembed` fallback.
2. **`serp-hydration` (`SerpHydrationTikTokProvider`)**: Queries Bing RSS + Naver for `site:tiktok.com` using `identity.queries.tiktokEn`, `identity.queries.tiktokAr`, and `identity.hashtags`, then hydrates each discovered video URL to extract `playAddr`, `cover`, and caption.
3. **`playwright` (`PlaywrightTikTokProvider`)**: Feature-flagged headless browser fallback with strict rate limit and circuit breaker.
4. **`apify` (`ApifyTikTokProvider`)**: Optional external actor integration enabled automatically when `APIFY_TOKEN` is set in environment variables.
5. **Mandatory Phase C Verification**: Every TikTok candidate is verified visually (cover image + extracted keyframes + `mustNotBe` attribute check) before emission, preventing off-type tools or unrelated viral videos from passing.

---

## 2. Multi-Marketplace Amazon Reachability Spike (Phase D)

We tested direct HTTP search (`undici` keep-alive agent + realistic Chrome headers) across 6 Amazon marketplaces for `"photocatalyst mosquito killer"`:

| Marketplace | Domain | HTTP Status | Latency (ms) | HTML Size | CAPTCHA | Parsed ASIN Cards (Page 1) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **United States** | `amazon.com` | `200` | `640 ms` | `~920 KB` | Occasional rate-limit under burst | `48 - 57` |
| **United Kingdom** | `amazon.co.uk` | `200` | `966 ms` | `1,375,754 B` | `false` | **`109`** |
| **United Arab Emirates** | `amazon.ae` | `200` | `928 ms` | `1,357,823 B` | `false` | **`69`** |
| **Saudi Arabia** | `amazon.sa` | `200` | `946 ms` | `888,133 B` | `false` | **`51`** |
| **Egypt** | `amazon.eg` | `200` | `897 ms` | `977,903 B` | `false` | **`49`** |
| **Germany** | `amazon.de` | `200` | `1,058 ms` | `876,946 B` | `false` | **`41`** |

### Multi-Marketplace Conclusion
All 5 international marketplaces (`.co.uk`, `.ae`, `.sa`, `.eg`, `.de`) responded in **< 1.1 seconds** with **0 CAPTCHAs** and **41 to 109 product cards per page**. In Phase D, when `amazon.com` yield is below target or hits a block, the expansion pipeline automatically queries `.co.uk`, `.ae`, `.sa`, `.eg`, and `.de`, maps discovered ASINs, and extracts customer review videos across marketplaces.
