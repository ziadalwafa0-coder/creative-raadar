# ZIP replacement release — 2026-10-30

Source: `D:/Ziad/Downloads/creative-radaar (2).zip`

Original ZIP SHA256: `143689D7B364C5E26719A65F16BEC4873D2F3DBFE09BF781D5ACEC393320CA64`.

## Prepared changes

- Added the Vercel API entry point and frontend/API routing; configured a 300-second function ceiling.
- Use `/tmp/creative-radaar` for serverless writable temporary files.
- Do not initialize Gemini without a configured key, so the service can start without optional image AI.
- Support the host-provided PORT.
- Repaired the dependency lockfile and excluded `.data`, `.aistudio`, environment files and local sessions from deployment.
- Generated server-only production code digests for the existing 16 codes. The private local configuration is excluded from all archives and deployment uploads.

## Verified locally

- Production frontend build and TypeScript check passed.
- Tests: 36 passed, 5 optional network tests skipped, zero failed (41 total).
- Local health endpoint returned 200; Gemini absent, FFmpeg available, Amazon robots endpoint reachable. The health check alone does not verify collection.
- Browser login with ZALS succeeded.
- A real search for ASIN B0B6ZSSWRL requested one video and returned one review by Mr Bogale, review R1TOPVNCA12RHV.
- Browser preview loaded the full video (readyState 4).
- Browser download created `D:/Ziad/Downloads/_So_fresh_so_clean__1793370429092.mp4`.
- FFprobe verified H.264 480x854 + AAC, duration 15.724042 seconds, 9,475,829 bytes.
- A 40/50-video search and image matching were NOT verified. Gemini is not configured.

## Publication blocked externally

Target: Vercel project `creative-raadar`, team `team_Q1522XbdPVXJuxDN9VLhJZap`, production domain `creative-raadar.vercel.app`.

The existing authenticated CLI can inspect the project, but BOTH adding production configuration and staging a production deployment fail:

> Your Team exceeded our fair use limits and has been blocked.

No replacement production deployment was created and the public domain was not changed. No paid upgrade or account/team workaround was attempted.

After the owner resolves the team restriction, configure CREATIVE_RADAAR_PEPPER and ACCESS_CODE_DIGESTS as server-only Secrets from the private local configuration. Then stage with `vercel deploy --prod --skip-domain`, test the deployed login/search/download, and promote that tested deployment. Serverless end-to-end behavior is still unverified.

Local running URL during this task: http://localhost:3032 . This is accessible on this computer only.
