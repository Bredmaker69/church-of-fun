# Clipping Dashboard

React + Vite app for uploading source videos, tracking processing status, and rendering generated clips in a dashboard UI.

## Prerequisites

- Node.js 20+
- npm
- A Firebase project with Firestore, Storage, and Functions enabled

## Setup

1. Install dependencies:

```bash
npm install
cd functions && npm install && cd ..
```

2. Create local env file:

```bash
cp .env.example .env.local
```

3. Fill in Firebase web app values in `.env.local`:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_FUNCTIONS_REGION` (defaults to `us-central1`)

## Run

```bash
npm run dev
```

## Run Locally On Mac (No Deploy Required)

This uses your local Functions emulator, so you do not need Firebase Blaze or Cloud deployment to test clip generation.

1. Create function-local env with your OpenAI key:

```bash
cp functions/.env.example functions/.env.local
```

Set `OPENAI_API_KEY` in `functions/.env.local`.

2. In terminal A, start the local function emulator:

```bash
npm run firebase:emulators:functions
```

3. In terminal B, start the frontend pointing at the local emulator:

```bash
npm run dev:local
```

4. Open the app URL shown by Vite (usually `http://localhost:5173`) and test upload.

Notes:
- Firestore and Storage remain on your Firebase project.
- Only the callable `generateClips` runs locally on your Mac.
- In `dev:local`, Storage upload is intentionally skipped and replaced with a local file reference so you can test processing flow without Storage auth/rules setup.
- In dev mode, the app defaults to local function emulation and local upload bypass unless explicitly set to `VITE_USE_FUNCTIONS_EMULATOR=false` or `VITE_SKIP_STORAGE_UPLOAD=false`.
- Local mode now renders real `.mp4` subclips in-browser via `ffmpeg.wasm`; the first render may take longer while ffmpeg core assets are downloaded.
- Local mode includes a **Manual Clip Lab** with video scrubbing, manual in/out ranges, and MP4 export.

## Quality checks

```bash
npm run lint
npm run build
```

## Notes

- Frontend upload flow writes a `videos` document in Firestore, uploads to Storage, then calls the callable function `generateClips`.
- The Cloud Function expects `OPENAI_API_KEY` in the Functions runtime environment.
- Optional: set `OPENAI_MODEL` in the Functions runtime (defaults to `gpt-4.1-mini`).
- The backend enforces deterministic clip shaping:
  - `CLIP_MIN_SECONDS` (default `8`)
  - `CLIP_MAX_SECONDS` (default `45`)
  - `CLIP_DEFAULT_SECONDS` (default `20`)
  - `CLIP_MIN_GAP_SECONDS` (default `1`)
  - `CLIP_TARGET_COUNT` (default `3`)

## Deploy Functions

1. Install root dependencies:

```bash
npm install
```

2. Create Firebase project mapping file:

```bash
cp .firebaserc.example .firebaserc
```

Then replace `YOUR_FIREBASE_PROJECT_ID` with your real project id.

3. Login to Firebase CLI:

```bash
npm run firebase:login
```

4. Set OpenAI secret:

```bash
npm run firebase:secrets:set:openai
```

5. Deploy callable function:

```bash
npm run firebase:deploy:functions
```
