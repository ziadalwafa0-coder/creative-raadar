# Creative Radaar — local setup

Requires Node.js 22 or newer. Install FFmpeg for video-frame verification.

1. Run `npm ci`.
2. Copy `.env.example` to `.env.local` and set your own `GEMINI_API_KEY`. Never share or commit that file.
3. Run `npm run build`, then `npm start`. Default port is 3000. On PowerShell set `$env:PORT='3040'` first to use port 3040.

Checks: `npm run lint`, `npm test`, `npm run build`.
Optional online identity tests require `RUN_NETWORK_TESTS=1` and valid provider configuration.
Optional CLIP model tests require `RUN_MODEL_TESTS=1` and download the model on first use.

Without a Gemini key, the UI runs and supports manual product identity entry. Automatic image identification requires the key.
Source availability depends on Amazon/TikTok access and provider configuration.
