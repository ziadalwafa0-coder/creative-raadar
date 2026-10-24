# Verification — 2026-10-24

## Actual live flow

The browser UI at http://127.0.0.1:5173 called the standalone backend on port 4320 using an existing access code. The backend launched fresh Playwright contexts with no Amazon account cookies.

- Live search `double rod clothes rack with wheels` returned 20 product hits. Observed ratings counts included 5,082, 1,039, and 65.
- The complete UI run inspected up to 10 ranked products and displayed **3 distinct customer videos**, including the critical review `Not what I expected.` Some other product pages had no parseable customer section and emitted PARSE_EMPTY warnings.
- The first video played through the media proxy: browser readyState 4, duration 54 seconds, currentTime >27 seconds, no media error.
- Clicking Download created `D:/Ziad/Downloads/Creative-Radaar-B0DQK9MPS2-1792841412146.mp4`. ffprobe verified H.264 480×854, AAC, duration 53.386667 seconds, size 31,438,071 bytes. The browser automation's download event timed out even though the actual file completed successfully.
- Clicking Start Again removed all old cards immediately and showed `جاري فحص المنتج 1 من 10 — البحث محفوظ مؤقتًا`. A later cached run displayed nine videos within the first browser observation (under one second) and eventually completed with **12 distinct customer videos**. The intervening fresh inspections populated additional positive cache entries; the first uncached run's count was three.

The latest local live run reached the requested limit of 12. No count of 40 or 50 is claimed for this architecture. A screenshot is saved in the task workspace outside this checkout as `creative-radaar-customer-reviews.png`.

## Cloud deployment checks

- With the user's explicit approval, the existing Railway workspace was changed from expired Trial to Free. A separate `creative-raadar` service was added inside the existing `positive-intuition` project; the existing `web` / `stockradaar` service source was not changed or deleted.
- Railway built the actual `backend/Dockerfile` successfully. Public backend: https://creative-raadar-production.up.railway.app. `/health` returned 200 with `source:public`, `cache:memory`, `persistentMedia:false`.
- Existing code authentication succeeded against the public backend. A real MP4 Range request through the signed media proxy returned 206, `bytes 0-1023/31438071`, `video/mp4`, and the MP4 `ftyp` signature.
- A real cloud search for the same clothes-rack query returned NDJSON with `BLOCKED` and `{done:true,count:0}`. A subsequent staged-browser run received Amazon's image-only error page titled `Sorry! Something went wrong!`, with zero ASIN rows and empty body text, despite HTTP 200. This is NOT an ordinary selector mismatch or a successful cloud video-discovery test. The prepared title-based detector classifies that page as BLOCKED rather than PARSE_EMPTY; this final detector patch awaits release. A configured external provider or country-matched proxy remains necessary.
- The staged Vercel UI successfully logged into the actual Railway backend using an existing code and displayed the source failure warning. CORS was verified for this exact staging origin. No blank failure or cross-product results were substituted.
- A production-target Vercel build is READY at https://creative-raadar-boyxxmhgb-ziad-aboalwafa.vercel.app. Its JavaScript contains the correct Railway backend URL and streaming client. The main custom domain has not been promoted to this build while cloud video discovery is blocked.
- The user is signing into the external provider. No provider key, residential proxy, paid subscription or Supabase service key has been configured by this work yet.

## Automated verification

12 backend tests passed, covering numeric parsing (Arabic/Persian/K), exact-URL dedupe, media SSRF allowlist, HLS URI rewriting, customer-only provenance including negative reviews, ordering/empty-product skip/12-video limit, positive and negative cache hits, explicit blocked warnings without caching failures, old-search cancellation, HTTP streaming before the next product finishes, server-side cancellation when a second HTTP search supersedes a delayed first search, and Amazon error pages returned with HTTP 200.

37 existing auth/isolation/drag tests passed. TypeScript checking and the root production build passed. These controlled tests use fixtures where appropriate; they do not establish live video availability for eleven products.

Static runtime search for the prohibited review-list path and explicit Amazon sign-in URL found no matches in `src`, `frontend`, `backend/src`, `api`, or `server.ts`. App access-code login remains deliberately supported; it is not an Amazon login.

## Acceptance matrix

| Requirement | Evidence / status |
|---|---|
| Videos appear progressively | Passed HTTP stream test and live UI progressed to 12 videos |
| Empty first product advances to second | Passed controlled pipeline test |
| New search removes old results and ignores old IDs | Passed cancellation tests; live Start Again cleared cards |
| All blocked produces a visible reason | Passed controlled error test; live PARSE_EMPTY warning rendered |
| Repeated search uses cache | Passed controlled cache test; live cached run showed nine videos in the first browser observation |
| No Amazon review-list/login navigation | Passed runtime-source scan and fresh-context architecture |
| 12 videos from a live product search | Achieved on the later run; the first run returned only 3 |
| Multiple marketplaces | Implemented selection/configuration; regional DOM layouts not live-verified |
| Residential proxies | Not configured or tested |
| External provider | Adapter implemented; no provider credentials configured/tested |
| Supabase persistence | Schema/adapter implemented; not configured or live-tested; memory cache used |
| Docker / Railway deployment | Actual Docker build and public health/media tests passed on Railway Free |
| Cloud customer-video discovery | Blocked by Amazon from the hosting IP; live run returned zero with an explicit warning |
| Public Vercel frontend switched to new backend | Staged build READY and wired correctly; main-domain promotion pending provider setup and a successful cloud search |
# Free browser collector verification — 2026-10-25

- No Apify, Unwrangle, paid proxy, subscription, or trial-credit API enabled.
- A real network smoke test ran the extension worker's request logic under Node from the user's connection, with credentials omitted and redirects rejected. Query `double rod clothes rack with wheels`: 20 matching product pages inspected, 21 distinct customer-proven videos returned, first five at 4.072 seconds; final result around 43 seconds. This is a real network test, **not** an installed Chrome extension E2E test and **not** proof that every query yields 40–50 videos.
- Five new controlled browser-collector tests pass: ratings ordering/error pages, customer-only exact-ASIN filtering/50 cap, cancellation discarding late product data, stopping at a challenge, fixed operation/host restrictions and credential omission. Twelve backend tests also pass; TypeScript checks and production frontend build pass.
- Each browser search is separate and has no stored results. The extension has no cookies/tabs/storage permissions. It never uploads Amazon page HTML to Railway. The existing API remains responsible for app login and media proxying.
- Chrome UI verification: existing ZALS login against Railway succeeded, free browser mode and install links rendered. Search reported the extension missing (no ping response). The user reports installation; confirming which browser it was installed into is pending. No installed-extension E2E success or main-domain release is claimed. Browser automation policy blocks opening chrome://extensions; no alternate technique was used to bypass it.

