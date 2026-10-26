# 1.3.2 — one visible Amazon work tab

The user explicitly approved restoring collection through one visible Chrome tab. Automatic collection no longer performs direct Amazon HTML fetches. It reuses the work tab across products and jobs, including a new job started while tab creation is still pending. A challenge, login wall or access refusal stops navigation; only an explicit read-only check of the user-reviewed current page clears that state. No alternate identity, proxy or automatic transport fallback is used.

The soft image hint, run-local search-response sharing, customer-only provenance checks, ASIN isolation, distinct-clip deduplication, temporary results, independent image/video targets and bounded API/download waits remain in place.

Validation: TypeScript and production build pass. All 49 browser/extension tests pass, including single-tab reuse, tab-creation cancellation, stale-result isolation, reader privacy, lazy-media reveal and customer-only video filtering. The ZIP and local installation folder contain matching 1.3.2 runtime files with unchanged permissions.

Live verification is pending. After the installation handoff, the connected Chrome profile Ziad still reported 1.3.1. No collection was started using that obsolete extension. The updated UI has not yet been deployed; production remains on the preceding 1.3.1 revision. A live search, playback and download must be checked before claiming this release solves collection.
