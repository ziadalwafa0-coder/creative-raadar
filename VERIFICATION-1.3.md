# Chrome collector 1.3.0 verification — 2026-10-25

## User story and root cause

Product name/photo/count → extension-owned visible Chrome tab → rendered public Amazon search/product DOM → sanitized customer media → progressive ephemeral cards → existing signed media proxy for playback/download.

The former anonymous HTML fetch received Amazon 503/error pages even when ordinary Chrome navigation worked. The primary path now performs normal visible tab navigation; the worker contains no Amazon HTML fetch fallback. A second real parsing bug selected brand headings instead of product titles on some search cards. The reader/parser now recognize the actual labelled product heading.

## Actual Chrome evidence

- Installed extension 1.3.0, Chrome profile Ziad; local frontend uses the deployed Railway auth/media API.
- Arabic `المكواه المحمولة` translated to `Portable Iron`; automatic source navigation completed **30/30 customer videos**. This was name-only collection across iron listings, **not** validation of the user's specific green iron. Screenshot outside the checkout: `creative-radaar-automatic-30-counts.png`.
- Changing input immediately removed all prior iron cards. Direct `https://www.amazon.com/dp/B0B6ZSSWRL` with 30 requested returned **4 available customer videos**, all tied to that ASIN; did not fill with other products.
- A brand-specific shoe query later genuinely returned Amazon's explicit no-results page. The broader `9 Tier Shoe Rack with Cover` read real matching-name candidates and ran local image comparison.
- Positive image control: uploaded the actual Amazon search image `61i8X-0VWCL._AC_UL320_.jpg`. Compared 11 candidates, displayed B0B6ZSSWRL as the accepted result. After explicit confirmation, collected **3/3 customer videos**, all product links B0B6ZSSWRL, review IDs R3PU9JAB126EDR, R2RUYDQRGQUIFK, R1TOPVNCA12RHV. Critical reviews were correctly retained.
- A higher-resolution catalogue rendition of the same shoe photo was rejected by the strict visual gates in an earlier run. This is a known false-negative limitation, not proof that image matching universally works. No threshold was weakened to force acceptance. Exact URL/ASIN is the reliable source identity route; visual similarity alone is not proof of SKU identity.

## Controlled verification

40 frontend/extension tests and 12 backend tests passed. Both TypeScript checks and the production build passed. Tests cover normal visible navigation with zero HTML fetch, cancellation and stale-job isolation, source URL binding, closing the work tab, challenge stop without transport fallback, sanitized public data only, title parsing, exact ASIN provenance, customer-only media, independent counts, pagination past 20 products, image failure vs no match, media allowlist and authentication expiry.

An app heartbeat keeps the MV3 worker alive only while an active search/local image inference is running; completion or cancellation stops it. This avoids losing in-memory job bindings during long local inference. No media or session state is persisted by the extension, and no new permissions were added.

## Limits

Counts are requested ceilings, not guaranteed availability. No live 40/50-video run or eleven-product benchmark is claimed for this release. Amazon can require a challenge/sign-in or refuse a page; the job then stops for the user. Standard desktop Chrome is required. Results clear when changing inputs or refreshing. This report records the tested local flow; production checks are recorded after release.
