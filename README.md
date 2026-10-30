<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Creative Radaar

React/Vite frontend and an Express server for finding Amazon customer-review media. Search results are temporary. This deployment runs the server on Railway; a static-only Vercel deployment cannot run the collector.

View your app in AI Studio: https://ai.studio/apps/ff65a0a5-87b8-4e89-8a97-bf11506d19d8

## Run Locally

**Prerequisites:** Node.js 22+ and FFmpeg. Python/Scrapling is optional locally and installed by the production Dockerfile.


1. Install dependencies:
   `npm ci --ignore-scripts`
2. Copy `.env.example` to `.env.local` and configure server authentication. Optionally set `GEMINI_API_KEY` there. Never use a `VITE_` variable for a provider key or commit credentials.
3. Run the app:
   `npm run dev`

## Product identity before collection

Uploading a product image immediately proposes an editable English shopping name. With `GEMINI_API_KEY` configured, the server sends Gemini a reduced JPEG plus the supplied name. Visible brand/model text is kept separate; unknown brands and models must not be invented. The image is not persisted by the analysis endpoint.

If Gemini is missing, times out or exhausts its quota, a browser-only quantized CLIP model supplies a limited category suggestion. The first run downloads model weights from Hugging Face into the browser cache. This fallback is not OCR and does not establish a brand, model or SKU.

Before review collection, the app checks candidate titles (including explicit model/tier conflicts) and compares candidate photos with the reference. Weak visual evidence does not automatically start a search: the user must confirm a product card or supply its direct URL. A direct URL alone stays on that page. With the original image and a non-low-confidence Gemini profile, collection can inspect up to three search pages and 48 additional candidates; each extra listing requires a fresh server-side visual approval against the original image. Different brands/models are not claimed to be the same SKU. Customer-video extraction excludes unlinked creator-only demos, seller videos and unrelated ASIN recommendations.

Review collection emits results incrementally, follows same-ASIN next-page links (up to ten review pages), and deduplicates stream IDs across listings. Sign-in pages are access restrictions, not empty review lists. Partial caches do not prevent a larger subsequent request. Refreshing an older image search prepares the visual input again so it can use verified expansion too. The requested count remains a target, not a guarantee.

### Gemini on Railway

Set `GEMINI_API_KEY` in **Variables** of the `creative-raadar` service, then deploy/restart it. Keep a non-billing Google project if free-only usage is required. No billing or paid subscription is enabled by this code. `GEMINI_MODELS` optionally overrides the comma-separated server model list. Current supported model IDs and free-tier availability are documented by [Google](https://ai.google.dev/gemini-api/docs/models) and [Google pricing](https://ai.google.dev/gemini-api/docs/pricing).

`GET /api/health` reports whether a key is configured, not whether a live Gemini inference succeeded. Both `/api/product-identity/analyze` and `/api/product-identity/candidates` require the existing access-code session. SDK fixture tests are not evidence of a live provider request.

## Validation and limits

Run `npm run lint`, the Node tests (`NODE_ENV=test node --import tsx --test src/server/*.test.ts src/utils/*.test.ts` on Unix), then `npm run build`. On PowerShell set `$env:NODE_ENV='test'` before the test command and set it to `production` before building.

Amazon can deny or challenge a request. Neither Gemini nor image similarity removes that restriction. An exact item may have fewer customer videos than the requested count; the app must report that shortfall rather than substitute another product's reviews. A keyless local image test and mocked SDK tests do not prove a successful end-to-end Gemini/Amazon search.
