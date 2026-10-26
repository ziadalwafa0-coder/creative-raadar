# Customer review UI

The existing Vite/React application imports `CustomerReviewsApp.tsx` from this folder when `VITE_REVIEWS_API_URL` is configured. Build from the repository root, not this folder.

`ndjson.ts` reads streaming events and owns cancellation/search IDs. `ReviewPlayer.tsx` supports native MP4/HLS and hls.js, starts media requests on explicit playback, and destroys its player when a result unmounts. The optional image supports local visual matching. A thumbnail of at most 320px can be sent to the authenticated query helper and Gemini when configured; it is not persisted by the application. Failed visual comparison falls back to the supplied name, without claiming a confirmed match.

Results stay in React state. New input, a new marketplace, a new search or a refresh clears them. No project storage is used by this UI. The short-lived access-code session token stays in sessionStorage; API/provider secrets never enter the client bundle.

Automatic extension collection uses one visible Amazon work tab. A challenge or access refusal stops navigation; the user can inspect the tab and explicitly request a read-only check before starting a new job. No direct HTML fetch or alternate identity is used. Search pages are shared between image and media passes only within the current run. VSE content identifiers prevent multiple encodings of one clip from counting as separate customer videos.

See `../backend/README.ar.md` for deployment and configuration.
