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

## Quality checks

```bash
npm run lint
npm run build
```

## Notes

- Frontend upload flow writes a `videos` document in Firestore, uploads to Storage, then calls the callable function `generateClips`.
- The Cloud Function expects `OPENAI_API_KEY` in the Functions runtime environment.
- Optional: set `OPENAI_MODEL` in the Functions runtime (defaults to `gpt-4.1-mini`).

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
