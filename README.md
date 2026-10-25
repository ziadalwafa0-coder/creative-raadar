<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

## Customer review streaming backend

The new public-page-only Fastify backend and Arabic React UI are documented in [backend/README.ar.md](backend/README.ar.md). Set `VITE_REVIEWS_API_URL` to activate the new frontend. Backend source, deployment files and cache schema are under `backend/`. See [backend/VERIFICATION.md](backend/VERIFICATION.md) for the actual deployment status and test limits.

## Product isolation fix — 2026-10-24

See [the Arabic diagnosis, simulation and upgrade notes](FIX_REPORT_AR.md).
Run `npm ci`, `npm run lint`, `npm run build`, `npm run test:isolation`, and `npm run test:isolation:api`.
Do not replace an existing `.data` directory when upgrading. No user data is included in this source package.

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/ff65a0a5-87b8-4e89-8a97-bf11506d19d8

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
# Free browser collection

Arabic product names are converted into commerce search terms before collection, for example `جزامة ٩ دور بغطاء` → `9 Tier Shoe Rack with Cover`. The local catalogue lexicon keeps tier counts, wheels/covers, dimensions, wattage, brands and model tokens; these are search phrases, not claims of an exact verified listing title. Unknown names use Chrome's [on-device Translator API](https://developer.chrome.com/docs/ai/translator-api) with an anonymous [MyMemory fallback](https://mymemory.translated.net/doc/usagelimits.php) (5,000 characters/day, no key, no paid subscription). Only the product name is sent to the fallback if needed; no email/account information is supplied. English names bypass translation. The English search phrase is shown in the UI; changing input cancels any pending translation and search. Translation cache is bounded in-memory only.

The Chrome extension reads public Amazon search/product pages using each user's connection, without a paid API or Amazon session. Installation and scope: [extension/README.ar.md](extension/README.ar.md). Build the downloadable ZIP with `npm run build:extension`; `npm run build` includes it automatically. The frontend uses the extension exclusively for collection and hides its install prompt after a live handshake. Users choose videos, customer photos, or both, and independent counts from 1 to 50. Up to five search pages (20 products per page) are inspected until requested counts are met or the source is exhausted/blocked; availability is not guaranteed. Results remain in React memory and clear on new input/search/refresh. Authentication and video delivery still use the existing backend.

