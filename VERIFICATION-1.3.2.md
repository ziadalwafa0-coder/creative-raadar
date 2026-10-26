# 1.3.2 — one visible Amazon work tab

The user explicitly approved restoring collection through one visible Chrome tab. Automatic collection no longer performs direct Amazon HTML fetches. It reuses the work tab across products and jobs, including a new job started while tab creation is still pending. A challenge, login wall or access refusal stops navigation; only an explicit read-only check of the user-reviewed current page clears that state. No alternate identity, proxy or automatic transport fallback is used.

The soft image hint, run-local search-response sharing, customer-only provenance checks, ASIN isolation, distinct-clip deduplication, temporary results, independent image/video targets and bounded API/download waits remain in place.

Validation: TypeScript and production build pass. All 52 browser/extension tests pass, including single-tab reuse, tab-creation cancellation, worker-restart recovery, owner-tab cleanup, stale-result isolation, repeated intermediate search pages, reader privacy, lazy-media reveal and customer-only video filtering. The ZIP and local installation folder contain matching 1.3.2 runtime files with unchanged permissions.

## Live local verification

- A fresh Chrome page confirmed extension 1.3.2. Direct collection from `B0B6ZSSWRL` (Calmootey 9-tier covered shoe rack) returned 3 customer videos and 2 customer photos. The source inventory showed one newly created work tab for that session.
- A video played with readyState 4 and advancing currentTime. The downloaded MP4 was 42,787,511 bytes; ffprobe verified H.264 video at 480×640, AAC audio and duration 72.864458 seconds. The browser download wait exceeded the automation tool's time limit, but the completed file was independently verified on disk.
- An Arabic name-plus-photo run (`جزامة 9 دور بغطاء`, requested 40 videos) initially returned 17 customer videos. After fixing premature termination on repeated pages, the same test returned 21 customer videos and completed on search page 5. Image comparison timed out, so the UI correctly discloses that model/image matching is unconfirmed and collection uses name/specification matching. The requested 40 were not obtained; no seller/influencer content was used to fill the count.
- The progress counter now counts matching products actually inspected, rather than including rejected search cards.

- Idle time between jobs revealed that Chrome can suspend the worker and lose its in-memory tab reference. The patch marks its owned public source tab with a URL fragment, recovers only that tab after suspension, checks its current page before any navigation and closes only its owned source tab when the app tab closes. No cookie or media storage was added. Regression tests cover recovery, challenge refusal after recovery and cleanup without affecting unrelated Amazon tabs. Live verification of the recovery patch remains pending: the installed copy reports 1.3.2 but not the new `tabRecovery` capability. Its Loaded-from path was requested. The core 1.3.2 collector remains compatible and was live-tested successfully.

- Production deployment `dpl_EPXX6g3w37f464Ka9Gt6WuLDMGSo` served the 1.3.2 UI. Its direct-ASIN smoke test returned 3 videos and 2 photos without collection errors. A subsequent play attempt encountered an expired backend session, revealing a separate UX bug: reauthentication cleared collected results.
- Fixed reauthentication to stop active work/transfers while retaining this tab's public result metadata in React memory. Explicit logout, a new product or page refresh still clears it. Tested using an isolated backend on 127.0.0.1:4321 with a deliberately 1.5-second session TTL: collected 3 real customer videos, triggered expiry on playback, signed in again and recovered the same 3 results without a new source search. Explicit logout followed by login showed zero results. The short TTL applies only to that local QA process, not production.

Production publication is authorized. The session-preservation follow-up is awaiting publication at this commit. These checks do not guarantee a count for every product or establish exact visual matching.
