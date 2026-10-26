# Reference ZIP and AI Studio comparison — 2026-10-26

Reference: `creative-radaar.zip`, SHA-256 `ae6d22d734225d34543701ee020b6110e4227701c4e9bd5d11712603d65fb6f5`.

## Observed architecture

The reference is a React/Vite frontend with an Express server. `src/server/streamSearch.ts` streams results and downloads on demand; `src/server/worker.ts` also supports stored projects and media preparation. `src/server/amazonUs.ts` discovers listings and extracts structured video records. Gemini supports product analysis and search grounding. AI Studio runs this backend in Google's preview environment; the current production collector instead makes public requests from Chrome. Replacing only the interface cannot preserve the original hosting behavior.

The live AI Studio preview was inspected read-only while the user's existing job ran. Its tooth-product search progressed from 5 results to 20. The visible labels identified only 5 as customer reviews; the other 15 were creator/marketer or seller/manufacturer demonstrations. These observations do not prove exact image matching or verified purchase. A backend debug message also recorded a Google search-grounding quota error (429); that did not prevent this particular job from showing results.

## Changes adopted

- Preserve progressive temporary results, independent video/photo targets and on-demand downloads in the current simple interface.
- Deduplicate Amazon VSE clips by their content identifier across MP4/HLS renditions and products. Different encodings cannot fill the requested customer-video count multiple times.
- Remove fabricated availability, purchase verification, reviewer name, stock image and duration from the legacy registry adapter. It must not claim readiness without a discovery implementation or substitute a thumbnail for video.
- Continue enforcing explicit customer provenance and ASIN isolation in the active collector. Do not fill a customer-only request with seller or influencer content.

## Unresolved source dependency

The reference rotates impersonated crawler identities and retries source requests; this was not adopted. No API key, paid provider or Google billing change was made. The current direct Chrome source returned 503 in the documented portable-iron and shoe-rack tests. These code corrections do not establish successful live no-tab collection or guarantee 40–50 customer clips. An accessible, authorized source is still required for that behavior.

## Validation

47 browser/extension tests, 1 legacy-adapter test and 15 backend tests pass. The new regression test verifies that HLS/MP4 versions of one clip count once and collection continues to find a distinct clip. The adapter test verifies that URLs cannot fabricate provenance or turn thumbnails into downloadable video.
