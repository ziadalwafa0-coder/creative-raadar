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
- Chrome extension E2E: after installation and the anonymous HTML Accept/Accept-Language request update, an actual browser run returned 19 customer-proven videos and 5 customer photos for the clothes-rack query. The extension install panel disappeared after handshake. A video played (readyState 4, no error) and UI downloads produced a 753,449-byte MP4 and a 67,053-byte JPG in Downloads. No paid provider or Amazon account cookies were used.
- New media controls select videos/photos/both and separate requested counts (1–50). Separate live result counters prevent confusing the 20-product batch with a 20-video cap. Pagination is limited to five search pages; the bridge explicitly advertises pagination support and the worker echoes the actual requested page to prevent old extension versions silently repeating page one.
- Eight controlled collector tests pass, including a 40-video request spanning two pages, photo provenance and images-only limits. Twelve backend tests and TypeScript/build checks pass. A live 40-video Chrome run remains in progress at release request; do not represent the controlled 40-video test as 40 live results.
- The user explicitly requested publishing the current version while the live 40-video test is ongoing. Browser automation policy blocks opening chrome://extensions; users performed installation/reloads manually and no alternate technique bypassed that restriction.

## Follow-up verification and compatibility fix

- The requested current version was published to https://creative-raadar.vercel.app/ as Vercel deployment `dpl_F8ciKTeq55dYcCt8C2WmkTK64a5v` from commit `1379442`. Anonymous HTTP returned 200; existing app login and extension collection were exercised on the main domain. Later fixes below have **not** been published pending verification, following the user's request to complete tests first.
- Main-domain Chrome runs requested 40 videos plus 5 photos: clothes rack returned 26 videos/5 photos; cordless water flosser returned 18/5. Changing the product immediately removed all prior cards. These counts are actual Chrome results, not proof of 40 live videos.
- The same current worker and parser in an anonymous Node network test reached **50 water-flosser customer videos in 73.228 seconds**, across 32 inspected products and two search pages. A separate regression reached **50 covered shoe-rack videos + 3 photos in 54.972 seconds**, across 23 products and two pages. Car vacuum reached **36 videos + 3 photos**, then Amazon returned 503 on a later search page. The multi-query run stopped immediately at that block; the remaining nine planned query types were not run. Counts/ASINs are recorded in `LIVE-REGRESSION.json`; no video binaries are stored by the app.
- Root compatibility issue: the old bridge's ping returned the extension manifest version without testing the worker implementation. Thus a newer-looking version could still return a page response without the requested page number. Version **1.2.1** adds a worker-backed protocol-2 handshake, a mandatory actual page echo for every search response, and a controlled test proving older replies cannot win a response race. Chrome no longer silently accepts an outdated worker. No claim is made that repeated manifest version metadata alone proves compatibility.
- Nine collector tests + twelve backend tests + six legacy auth tests + twenty-eight isolation/rules tests + ten drag-overlay tests = **65 passing controlled tests**. Root/backend TypeScript checks pass. The tests distinguish mocked sources from the real network and Chrome evidence above.
- A clean unpacked extension folder was prepared at `C:/Users/Al Asdikaa/Documents/Codex/Creative-Radaar-Chrome-1.2.1`; its manifest/worker/bridge match the repository source. Installed-worker protocol-2 verification is still pending. Old extension copies should be disabled to avoid duplicate requests. No subsequent production release is claimed before that verification.

## Completed Chrome 1.2.1 verification and Arabic naming

- The user-supplied extension screenshot confirmed the earlier installed card was 1.2.0. After the user loaded/enabled the clean 1.2.1 copy, the current UI's worker-backed handshake reported **1.2.1** and hid the install prompt.
- Actual Chrome E2E with that worker: query `cordless water flosser`, request 50 videos and 5 photos, finished with **50/50 videos and 5/5 photos, no search errors**. This establishes live display of 50, independently of the earlier Node tests. It does not establish availability of 50 for arbitrary product types or that every individual source file will play forever.
- UI download actions saved `Creative-Radaar-B01GNVF8BK-1792930637916.mp4` (25,547,773 bytes) and `Creative-Radaar-B0CHFT6T5P.jpg` (10,502 bytes). Earlier verified playback reached readyState 4 without errors on another live clip. Some later selected water-flosser clips failed lazy playback and were hidden by the existing failure handling; do not claim all 50 were individually playback-verified.
- Actual Arabic UI flow first translated `جهاز خيط الأسنان المائي` to `Portable Water Flosser` and returned 3 requested videos plus 2 requested photos. The subsequent commerce-name optimizer was verified in Chrome with `جزامة ٩ دور بغطاء` → `9 Tier Shoe Rack with Cover`, also returning 3 requested customer videos and 2 photos. The optimizer preserves meaningful counts, dimensions, explicit features and models rather than literally translating Egyptian catalogue labels.
- Sixteen collector/naming/translation tests + twelve backend + six auth + twenty-eight isolation/rules + ten drag-overlay = **72 passing controlled tests**. Native/free fallback, English bypass, in-memory translation cache, quota/error rejection and cancellation of late translations are covered. Root and backend TypeScript checks pass.
- Final release includes worker-backed compatibility checks, media type/count controls, progressive collection, ephemeral results and Arabic commerce-name normalization. No paid provider, new subscription, Amazon session cookie or persistent media storage was introduced.

