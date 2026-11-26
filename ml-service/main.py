import os
import time
from contextlib import asynccontextmanager
from typing import Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from openai import OpenAI
from pydantic import BaseModel

from emotion_audio import CORE_CLASSES, analyze_audio_emotions, load_audio_model
from emotion_text import (
    MOOD_LABELS_UK,
    analyze_text_emotions,
    detect_crisis,
    get_text_classifier,
)

load_dotenv()

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "whisper-large-v3")
TEXT_WEIGHT = 0.72
AUDIO_WEIGHT = 0.28


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Предзагружаем обе нейросети при старте сервера
    print("Ініціалізація ML-моделей MoodVoice...")
    get_text_classifier()
    audio_bundle = load_audio_model()
    if audio_bundle is not None:
        print("Акустична PyTorch-модель завантажена.")
    else:
        print("УВАГА: акустична модель не знайдена, буде використано лише NLP.")
    yield


app = FastAPI(title="MoodVoice ML Service", lifespan=lifespan)


def get_whisper_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY не знайдено у файлі .env")
    return OpenAI(
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL", "https://api.groq.com/openai/v1"),
    )


def fuse_emotions(
    text_emotions: Dict[str, float],
    audio_emotions: Optional[Dict[str, float]],
    has_text: bool,
) -> Dict[str, float]:
    """Адаптивный Late Fusion: учитывает конфликт между ровной речью и эмоциональным текстом."""
    if audio_emotions is None:
        return text_emotions
    if not has_text:
        return audio_emotions

    text_non_calm = 1.0 - text_emotions.get("calm", 0.0)
    audio_calm = audio_emotions.get("calm", 0.0)

    # Если человек говорит ровным тоном (audio -> calm), но слова явно эмоциональные,
    # отдаём приоритет тексту (компенсируем domain gap актёрских датасетов RAVDESS/TESS).
    if audio_calm >= 0.55 and text_non_calm >= 0.55:
        w_text, w_audio = 0.85, 0.15
    elif audio_calm < 0.45:
        # Интонация явно выразительная — возвращаем аудио полный вес
        w_text, w_audio = 0.65, 0.35
    else:
        w_text, w_audio = TEXT_WEIGHT, AUDIO_WEIGHT

    raw = {
        cls: w_text * text_emotions.get(cls, 0.0) + w_audio * audio_emotions.get(cls, 0.0)
        for cls in CORE_CLASSES
    }
    total = sum(raw.values())
    if total <= 1e-6:
        return {"calm": 1.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}

    return {cls: round(val / total, 3) for cls, val in raw.items()}


class AnalysisResponse(BaseModel):
    transcript: str
    emotions: Dict[str, float]
    text_emotions: Dict[str, float]
    audio_emotions: Optional[Dict[str, float]] = None
    overall_mood: str
    confidence: float
    is_low_confidence: bool
    crisis_detected: bool
    crisis_message: Optional[str] = None
    processing_time_sec: float


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "audio_model_loaded": load_audio_model() is not None,
    }


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_audio(file: UploadFile = File(...)):
    start_time = time.time()

    allowed_types = (
        "audio/webm", "video/webm",
        "audio/wav", "audio/x-wav", "audio/wave",
        "audio/mpeg", "audio/mp3",
    )
    filename = file.filename or "audio.webm"
    allowed_exts = (".webm", ".wav", ".mp3")

    if (
        file.content_type
        and not any(t in file.content_type for t in allowed_types)
        and not filename.lower().endswith(allowed_exts)
    ):
        raise HTTPException(status_code=400, detail=f"Непідтримуваний формат: {file.content_type}")

    audio_bytes = await file.read()
    if len(audio_bytes) > 25 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Файл перевищує ліміт 25 МБ")

    # 1. Распознавание речи (Whisper API)
    try:
        client = get_whisper_client()
        transcription = client.audio.transcriptions.create(
            model=WHISPER_MODEL,
            file=(filename, audio_bytes),
        )
        transcript_text = transcription.text.strip()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Помилка Whisper API: {str(e)}")

    # 2. Текстовый анализ эмоций + кризисный детектор
    has_text = len(transcript_text) >= 3
    text_emotions, _, text_low_conf = analyze_text_emotions(transcript_text)
    crisis_detected, crisis_message = detect_crisis(transcript_text)

    # 3. Акустический анализ эмоций по MFCC (PyTorch)
    audio_result = analyze_audio_emotions(audio_bytes)
    audio_emotions = audio_result[0] if audio_result is not None else None

    # 4. Гибридное объединение (Late Fusion)
    fused_emotions = fuse_emotions(text_emotions, audio_emotions, has_text=has_text)
    dominant_key = max(fused_emotions, key=fused_emotions.get)
    overall_mood = MOOD_LABELS_UK[dominant_key]

    confidence = round(max(fused_emotions.values()), 2)
    is_low_confidence = (confidence < 0.45) or (not has_text and audio_emotions is None) or (text_low_conf and audio_emotions is None)

    elapsed = round(time.time() - start_time, 2)
    return AnalysisResponse(
        transcript=transcript_text,
        emotions=fused_emotions,
        text_emotions=text_emotions,
        audio_emotions=audio_emotions,
        overall_mood=overall_mood,
        confidence=confidence,
        is_low_confidence=is_low_confidence,
        crisis_detected=crisis_detected,
        crisis_message=crisis_message,
        processing_time_sec=elapsed,
    )