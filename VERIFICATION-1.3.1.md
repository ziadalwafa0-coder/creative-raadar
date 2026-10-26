# 1.3.1 release verification — 2026-10-26

This release changes automatic collection to public HTTP requests from the Chrome extension. It does not create or navigate Amazon tabs. Amazon may reject these requests; this release does not guarantee a video count or successful live collection.

## Verified
- 46 browser/extension tests pass, including no-tab transport, cancellation, source rejection, stale-result isolation, API timeouts, alternate search-card markup and cross-query deduplication.
- 15 backend tests pass, including authenticated optional query-helper validation and mocked Gemini responses.
- 28 product isolation and 6 API isolation tests passed during implementation.
- TypeScript check and production build pass.
- Extension manifest and packaged ZIP use version 1.3.1 with unchanged permissions.

## Limits and configuration
- Live production test now confirms the connected extension is 1.3.1 (the page's rendered data-extension-version). Login with the assigned code succeeded. Arabic portable-iron name plus its reference photo translated to `portable iron`, then the first direct Amazon request returned 503. The run stopped with zero media and no new Amazon tabs. Live collection is therefore blocked, not verified as successful. No alternate source transport was attempted after rejection.
- The optional server query helper requires GEMINI_API_KEY on the reviews backend. No key was configured or paid service enabled. The UI falls back to free name translation.
- An optional image thumbnail is at most 320 pixels and may be sent to the reviews backend and Gemini when configured. The application does not persist the thumbnail.
- Product images are a soft search hint. Model identity is not guaranteed by image matching alone. A direct Amazon URL binds collection to its ASIN.
- Lazy review-video reveal applies to the optional reader of an already-open page. HTTP collection cannot execute the source page's lazy JavaScript.
- The remote Railway backend timed out during an earlier check; a subsequent production health check returned 200 and production login worked. Frontend API waits are now bounded. Logout clears local session/results immediately while server revocation runs separately.
- Downloads reject non-media responses and time out. Temporary object URLs and active downloads are cancelled on a new product or session expiry. Existing-page imports preserve the reader diagnostics.
- A subsequent name-only `9 Tier Shoe Rack` production test also returned 503. The user's different unreadable-results response could not be reproduced as the same HTML; no claim is made that its exact source layout was identified. The parser now accepts `.s-result-item[data-asin]` cards as well as typed cards, recognizes challenge forms, and distinguishes an unreadable response from explicit zero results.
- The image and media passes share an in-memory search response only for the current run. An image-comparison timeout no longer causes a second request for that same search page. Source parser failures stop the run and are shown once rather than being mislabeled as a comparison failure followed by a duplicate search error. These changes are covered by regression tests; the Amazon source refusal remains unresolved.

Production deployment was explicitly requested by the user after these limits were described. Changes are retained on the fix/reviews-video-reveal-1.3.1 branch.
