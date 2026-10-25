# 1.3.1 release verification — 2026-10-26

This release changes automatic collection to public HTTP requests from the Chrome extension. It does not create or navigate Amazon tabs. Amazon may reject these requests; this release does not guarantee a video count or successful live collection.

## Verified
- 43 browser/extension tests pass, including no-tab transport, cancellation, source rejection, stale-result isolation and cross-query deduplication.
- 15 backend tests pass, including authenticated optional query-helper validation and mocked Gemini responses.
- 28 product isolation and 6 API isolation tests passed during implementation.
- TypeScript check and production build pass.
- Extension manifest and packaged ZIP use version 1.3.1 with unchanged permissions.

## Limits and configuration
- Live Chrome end-to-end collection with 1.3.1 remains unverified. The connected test page reported 1.3.0 after the user installed 1.3.1; browser inspection was then stopped by the computer-use safety check.
- The optional server query helper requires GEMINI_API_KEY on the reviews backend. No key was configured or paid service enabled. The UI falls back to free name translation.
- An optional image thumbnail is at most 320 pixels and may be sent to the reviews backend and Gemini when configured. The application does not persist the thumbnail.
- Product images are a soft search hint. Model identity is not guaranteed by image matching alone. A direct Amazon URL binds collection to its ASIN.
- Lazy review-video reveal applies to the optional reader of an already-open page. HTTP collection cannot execute the source page's lazy JavaScript.
- The remote Railway backend timed out during a prior live health check. Local authentication worked; this is separate from Amazon source access.

Production deployment was explicitly requested by the user after these limits were described. Changes are retained on the fix/reviews-video-reveal-1.3.1 branch.
