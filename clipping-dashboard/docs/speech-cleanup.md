# Speech Cleanup

## Architecture

Speech Cleanup is implemented as a backend-rendered audio effect for dialogue-focused tracks.

- Frontend state lives in timeline items and project defaults:
  - `dialogueTrackDefaults.speechCleanupEnabled`
  - `dialogueTrackDefaults.speechCleanupPreset`
  - `timelineItem.speechCleanupMode`
  - `timelineItem.speechCleanupPreset`
- Sanctuary resolves an effective setting per clip:
  - clip override `on`
  - clip override `off`
  - or `inherit` from the project dialogue default
- Backend processing lives in Firebase Functions and uses FFmpeg.

## Processing flow

1. Sanctuary resolves the effective Speech Cleanup setting.
2. If preview cleanup is enabled for a rendered backend clip, Sanctuary calls `prepareSpeechCleanupProxy`.
3. Functions extracts or reuses a cached cleaned-audio sidecar for the source clip.
4. Functions builds a preview proxy by copying video and replacing audio with the cleaned sidecar.
5. Final timeline renders pass the same effective setting into `renderTimelineEdits`.
6. The backend applies Speech Cleanup during the existing FFmpeg render path.

## Presets and engines

Frontend presets:

- `light`
- `medium`
- `strong`

Backend engine selection:

- preferred: `arnndn` when `SPEECH_CLEANUP_MODEL_PATH` points to a valid RNNoise-compatible FFmpeg model
- fallback: `afftdn` when no `arnndn` model is configured

The fallback keeps the feature working without blocking the app on model setup, but `arnndn` is the higher-quality path.

## Cache behavior

Processed audio sidecars are cached under the rendered clip storage temp directory:

- one cleaned-audio file per source clip + preset + engine
- reused across preview proxy generation and timeline export
- cleaned up when the source rendered clip expires

## Where to swap presets or models

Frontend preset resolution:

- `/Users/michaelbredimus/Library/CloudStorage/Dropbox/Church of Fun/clipping-dashboard/src/lib/speechCleanup.js`

Backend filter construction:

- `/Users/michaelbredimus/Library/CloudStorage/Dropbox/Church of Fun/clipping-dashboard/functions/lib/speechCleanup.js`

Backend render/proxy orchestration:

- `/Users/michaelbredimus/Library/CloudStorage/Dropbox/Church of Fun/clipping-dashboard/functions/index.js`

If you want different preset behavior, change the preset normalization and mapping in those two helper files first.

## DeepFilterNet extension path

The current architecture keeps heavy processing out of the React UI thread and centralizes cleanup orchestration in Functions.

To extend this to DeepFilterNet later:

1. add a Python worker entrypoint that accepts:
   - source audio path
   - preset / model choice
   - destination path
2. swap `ensureSpeechCleanupAudioProxy(...)` so it can choose:
   - `arnndn`
   - `afftdn`
   - or `deepfilternet`
3. keep the cache key shape the same, but include engine/model version
4. keep the frontend unchanged so the UI still only chooses:
   - on/off
   - preset

That keeps the editor UI stable while upgrading the backend audio engine.

