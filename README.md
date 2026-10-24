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
