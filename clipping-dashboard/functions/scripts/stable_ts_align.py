#!/usr/bin/env python3
"""
Run local stable-ts transcription with word timestamps and emit JSON.
This script is intentionally standalone so Firebase Functions can invoke it
without additional node dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import warnings
from typing import Any


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except Exception:
        return None
    if parsed != parsed:  # NaN
        return None
    return parsed


def _get_field(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def _normalize_word_text(value: Any) -> str:
    text = str(value or "").strip()
    text = text.replace("\n", " ").replace("\r", " ")
    text = " ".join(text.split())
    return text


def _normalize_word_entry(raw_word: Any) -> dict[str, Any] | None:
    text = _normalize_word_text(
        _get_field(raw_word, "word")
        or _get_field(raw_word, "text")
        or _get_field(raw_word, "token")
    )
    start = (
        _safe_float(_get_field(raw_word, "start"))
        or _safe_float(_get_field(raw_word, "start_seconds"))
        or _safe_float(_get_field(raw_word, "startSeconds"))
    )
    end = (
        _safe_float(_get_field(raw_word, "end"))
        or _safe_float(_get_field(raw_word, "end_seconds"))
        or _safe_float(_get_field(raw_word, "endSeconds"))
    )
    if not text or start is None or end is None or end <= start:
        return None
    return {
        "word": text,
        "start": round(float(start), 4),
        "end": round(float(end), 4),
    }


def _extract_words_and_segments(result: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    words: list[dict[str, Any]] = []
    segments_out: list[dict[str, Any]] = []

    raw_segments = _get_field(result, "segments", [])
    if raw_segments is None:
        raw_segments = []

    for index, segment in enumerate(raw_segments):
        seg_text = _normalize_word_text(_get_field(segment, "text", ""))
        seg_start = _safe_float(_get_field(segment, "start"))
        seg_end = _safe_float(_get_field(segment, "end"))
        raw_words = _get_field(segment, "words", []) or []
        normalized_words = []
        for raw_word in raw_words:
            parsed_word = _normalize_word_entry(raw_word)
            if parsed_word is None:
                continue
            words.append(parsed_word)
            normalized_words.append(parsed_word)

        if seg_start is not None and seg_end is not None and seg_end > seg_start:
            segments_out.append(
                {
                    "id": index,
                    "start": round(float(seg_start), 4),
                    "end": round(float(seg_end), 4),
                    "text": seg_text,
                    "wordCount": len(normalized_words),
                }
            )

    if not words and hasattr(result, "to_dict"):
        payload = result.to_dict()
        payload_words = payload.get("words", []) if isinstance(payload, dict) else []
        for raw_word in payload_words:
            parsed_word = _normalize_word_entry(raw_word)
            if parsed_word is None:
                continue
            words.append(parsed_word)

    if not words and segments_out:
        # Fallback: approximate word timings from segment timings if word timings are absent.
        for segment in segments_out:
            text = _normalize_word_text(segment.get("text", ""))
            seg_start = _safe_float(segment.get("start"))
            seg_end = _safe_float(segment.get("end"))
            if not text or seg_start is None or seg_end is None or seg_end <= seg_start:
                continue
            tokens = [token for token in text.split(" ") if token]
            if not tokens:
                continue
            slot = (seg_end - seg_start) / len(tokens)
            for idx, token in enumerate(tokens):
                start = seg_start + slot * idx
                end = seg_end if idx == len(tokens) - 1 else seg_start + slot * (idx + 1)
                words.append(
                    {
                        "word": token,
                        "start": round(float(start), 4),
                        "end": round(float(max(start + 0.02, end)), 4),
                    }
                )

    words.sort(key=lambda item: float(item.get("start", 0.0)))
    full_text = _normalize_word_text(_get_field(result, "text", "")) or " ".join(
        [segment.get("text", "") for segment in segments_out if segment.get("text")]
    ).strip()
    return words, segments_out, full_text


def _print_error(message: str, code: int = 1) -> int:
    payload = {
        "success": False,
        "error": message,
    }
    print(json.dumps(payload, ensure_ascii=True))
    return code


def _is_truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _configure_ssl() -> tuple[bool, str]:
    ca_bundle_value = str(os.getenv("STABLE_TS_CA_BUNDLE") or "").strip()
    insecure_download = _is_truthy(os.getenv("STABLE_TS_INSECURE_MODEL_DOWNLOAD"))

    if ca_bundle_value:
        ca_bundle_path = os.path.abspath(os.path.expanduser(ca_bundle_value))
        if not os.path.isfile(ca_bundle_path):
            return False, f"STABLE_TS_CA_BUNDLE file not found: {ca_bundle_path}"
        os.environ["SSL_CERT_FILE"] = ca_bundle_path
        os.environ["REQUESTS_CA_BUNDLE"] = ca_bundle_path
        os.environ["CURL_CA_BUNDLE"] = ca_bundle_path

    if insecure_download:
        # Local dev escape hatch when enterprise/self-signed MITM certs break model download.
        ssl._create_default_https_context = ssl._create_unverified_context
        os.environ["PYTHONHTTPSVERIFY"] = "0"

    return True, ""


warnings.filterwarnings("ignore", message=r".*FP16 is not supported on CPU.*")
warnings.filterwarnings("ignore", message=r".*Cannot clamp due to missing/no word-timestamps.*")
warnings.filterwarnings("ignore", message=r".*Failed to transcribe audio\\. Result contains no text\\..*")


def main() -> int:
    parser = argparse.ArgumentParser(description="stable-ts alignment worker")
    parser.add_argument("--audio-path", required=True, help="Path to audio file")
    parser.add_argument("--model", default="large-v3-turbo", help="stable-ts model name")
    parser.add_argument("--language", default="", help="Language code (optional)")
    parser.add_argument("--device", default="", help="Torch device (optional)")
    parser.add_argument("--compute-type", default="", help="Compute type hint (optional)")
    parser.add_argument("--prompt", default="", help="Prompt hint (optional)")
    args = parser.parse_args()

    audio_path = os.path.abspath(os.path.expanduser(args.audio_path))
    if not os.path.isfile(audio_path):
        return _print_error(f"Audio file does not exist: {audio_path}")

    ssl_ok, ssl_error = _configure_ssl()
    if not ssl_ok:
        return _print_error(ssl_error)

    try:
        import stable_whisper  # type: ignore
    except Exception as error:
        return _print_error(f"stable_whisper import failed: {error}")

    try:
        load_kwargs = {}
        if args.device.strip():
            load_kwargs["device"] = args.device.strip()
        if args.compute_type.strip():
            load_kwargs["compute_type"] = args.compute_type.strip()

        model = stable_whisper.load_model(args.model, **load_kwargs)
    except Exception as error:
        error_text = str(error)
        if "CERTIFICATE_VERIFY_FAILED" in error_text:
            hint = (
                "stable_whisper.load_model failed: certificate verification failed. "
                "Set STABLE_TS_CA_BUNDLE to a trusted PEM bundle, or set "
                "STABLE_TS_INSECURE_MODEL_DOWNLOAD=true for local dev fallback."
            )
            return _print_error(hint)
        return _print_error(f"stable_whisper.load_model failed: {error}")

    transcribe_kwargs = {
        "word_timestamps": True,
        "verbose": False,
        "vad": True,
        "suppress_silence": True,
    }
    if not args.device.strip() or args.device.strip().lower() == "cpu":
        transcribe_kwargs["fp16"] = False
    if args.language.strip():
        transcribe_kwargs["language"] = args.language.strip()
    if args.prompt.strip():
        transcribe_kwargs["initial_prompt"] = args.prompt.strip()

    def _transcribe_with_kwargs(kwargs: dict[str, Any]) -> tuple[Any | None, str]:
        try:
            try:
                return model.transcribe(audio_path, **kwargs), ""
            except TypeError:
                # Compatibility fallback for older/newer stable-ts signatures.
                fallback_kwargs = {}
                if args.language.strip():
                    fallback_kwargs["language"] = args.language.strip()
                return model.transcribe(audio_path, **fallback_kwargs), ""
        except Exception as error:
            return None, str(error)

    attempt_notes: list[str] = []
    result, transcribe_error = _transcribe_with_kwargs(transcribe_kwargs)
    if result is None:
        return _print_error(f"stable-ts transcription failed: {transcribe_error}")

    words, segments, transcript_text = _extract_words_and_segments(result)

    if not words:
        # Retry without VAD/silence suppression; those heuristics can over-prune speech on some clips.
        relaxed_kwargs = dict(transcribe_kwargs)
        relaxed_kwargs.pop("vad", None)
        relaxed_kwargs.pop("suppress_silence", None)
        attempt_notes.append("retry_without_vad")

        second_result, second_error = _transcribe_with_kwargs(relaxed_kwargs)
        if second_result is not None:
            words, segments, transcript_text = _extract_words_and_segments(second_result)
        elif second_error:
            attempt_notes.append(f"retry_error:{second_error[:160]}")

    if not words:
        note_text = f" Attempts: {'; '.join(attempt_notes)}." if attempt_notes else ""
        return _print_error(f"stable-ts produced no usable timed words.{note_text}")

    payload = {
        "success": True,
        "provider": "stable_ts_local",
        "modelUsed": args.model,
        "language": args.language.strip() or "auto",
        "text": transcript_text,
        "wordCount": len(words),
        "segmentCount": len(segments),
        "words": words,
        "segments": segments,
    }
    print(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:  # pragma: no cover
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"Unhandled stable-ts worker error: {error}",
                },
                ensure_ascii=True,
            )
        )
        raise SystemExit(1)
