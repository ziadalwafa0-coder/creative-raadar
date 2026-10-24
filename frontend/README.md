# Customer review UI

The existing Vite/React application imports `CustomerReviewsApp.tsx` from this folder when `VITE_REVIEWS_API_URL` is configured. Build from the repository root, not this folder.

`ndjson.ts` reads streaming events and owns cancellation/search IDs. `ReviewPlayer.tsx` supports native MP4/HLS and hls.js, starts media requests on explicit playback, and destroys its player when a result unmounts. The image is an optional local reference; it is not uploaded or used for visual matching.

Results stay in React state. New input, a new marketplace, a new search or a refresh clears them. No project storage is used by this UI. The short-lived access-code session token stays in sessionStorage; API/provider secrets never enter the client bundle.

See `../backend/README.ar.md` for deployment and configuration.
