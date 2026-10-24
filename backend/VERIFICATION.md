# Verification — 2026-10-24

## Actual live flow

The browser UI at http://127.0.0.1:5173 called the standalone backend on port 4320 using an existing access code. The backend launched fresh Playwright contexts with no Amazon account cookies.

- Live search `double rod clothes rack with wheels` returned 20 product hits. Observed ratings counts included 5,082, 1,039, and 65.
- The complete UI run inspected up to 10 ranked products and displayed **3 distinct customer videos**, including the critical review `Not what I expected.` Some other product pages had no parseable customer section and emitted PARSE_EMPTY warnings.
- The first video played through the media proxy: browser readyState 4, duration 54 seconds, currentTime >27 seconds, no media error.
- Clicking Download created `D:/Ziad/Downloads/Creative-Radaar-B0DQK9MPS2-1792841412146.mp4`. ffprobe verified H.264 480×854, AAC, duration 53.386667 seconds, size 31,438,071 bytes. The browser automation's download event timed out even though the actual file completed successfully.
- Clicking Start Again removed all old cards immediately and showed `جاري فحص المنتج 1 من 10 — البحث محفوظ مؤقتًا`. A later cached run displayed nine videos within the first browser observation (under one second) and eventually completed with **12 distinct customer videos**. The intervening fresh inspections populated additional positive cache entries; the first uncached run's count was three.

The latest live run reached the requested limit of 12. No count of 40 or 50 is claimed for this architecture. Screenshot: `../creative-radaar-customer-reviews.png` in the parent task folder, outside this checkout.

## Automated verification

10 backend tests passed, covering numeric parsing (Arabic/Persian/K), exact-URL dedupe, media SSRF allowlist, HLS URI rewriting, customer-only provenance including negative reviews, ordering/empty-product skip/12-video limit, positive and negative cache hits, explicit blocked warnings without caching failures, old-search cancellation, and HTTP streaming before the next product finishes.

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
| Docker / Railway / Fly deployment | Files prepared; Docker unavailable locally; not deployed |
| Public Vercel frontend switched to new backend | Not done: no public HTTPS backend URL configured |
