import io
import os
from typing import Dict, Optional, Tuple

import av
import librosa
import numpy as np
import soundfile as sf
import torch
import torch.nn as nn

CORE_CLASSES = ["calm", "joy", "sadness", "stress"]
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "audio_emotion_mlp.pth")


class AudioEmotionNet(nn.Module):
    def __init__(self, input_dim: int, num_classes: int = 4):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 256),
            nn.BatchNorm1d(256),
            nn.ReLU(),
            nn.Dropout(0.35),
            nn.Linear(256, 128),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.Dropout(0.25),
            nn.Linear(128, 64),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.Dropout(0.20),
            nn.Linear(64, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


def load_audio_from_bytes(audio_bytes: bytes, target_sr: int = 22050) -> np.ndarray:
    """Читает WAV, MP3, WebM и др. в моно float32 без установки системного FFmpeg."""
    try:
        y, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        if y.ndim > 1:
            y = np.mean(y, axis=1)
        if sr != target_sr:
            y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
        return y
    except Exception:
        pass

    container = av.open(io.BytesIO(audio_bytes))
    resampler = av.AudioResampler(format="flt", layout="mono", rate=target_sr)
    chunks = []
    for frame in container.decode(audio=0):
        for rframe in resampler.resample(frame):
            chunks.append(rframe.to_ndarray().reshape(-1))
    for rframe in resampler.resample(None):
        chunks.append(rframe.to_ndarray().reshape(-1))
    container.close()

    if not chunks:
        return np.zeros(target_sr, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32)


def extract_features_from_waveform(y: np.ndarray, sr: int = 22050) -> np.ndarray:
    """Извлекает 242 акустических признака (MFCC, Delta-MFCC, Mel, Chroma, ZCR, RMS, Centroid)."""
    if y is None or len(y) == 0:
        return np.zeros(242, dtype=np.float32)

    # Обрезаем тишину по краям (особенно важно для записей RAVDESS и пауз пользователя)
    trimmed, _ = librosa.effects.trim(y, top_db=25)
    if len(trimmed) > int(sr * 0.15):
        y = trimmed

    if len(y) < 2048:
        y = np.pad(y, (0, 2048 - len(y)))

    # Нормализация громкости
    peak = np.max(np.abs(y))
    if peak > 1e-6:
        y = y / peak

    # 1. MFCC (40 средних + 40 std = 80)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=40)
    mfcc_mean = np.mean(mfcc, axis=1)
    mfcc_std = np.std(mfcc, axis=1)

    # 2. Delta MFCC — динамика интонации (40 средних + 40 std = 80)
    if mfcc.shape[1] >= 9:
        delta = librosa.feature.delta(mfcc)
    else:
        delta = np.zeros_like(mfcc)
    delta_mean = np.mean(delta, axis=1)
    delta_std = np.std(delta, axis=1)

    # 3. Мел-спектрограмма в дБ (64 средних)
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=64)
    mel_db_mean = np.mean(librosa.power_to_db(mel, ref=np.max), axis=1)

    # 4. Хрома — тональность голоса (12 средних)
    stft = np.abs(librosa.stft(y))
    chroma_mean = np.mean(librosa.feature.chroma_stft(S=stft, sr=sr), axis=1)

    # 5. Энергия, темп переходов и «яркость» тембра (6 признаков)
    zcr = librosa.feature.zero_crossing_rate(y)
    rms = librosa.feature.rms(y=y)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)

    stats = np.array(
        [
            np.mean(zcr), np.std(zcr),
            np.mean(rms), np.std(rms),
            np.mean(centroid), np.std(centroid),
        ],
        dtype=np.float32,
    )

    features = np.concatenate(
        [mfcc_mean, mfcc_std, delta_mean, delta_std, mel_db_mean, chroma_mean, stats]
    ).astype(np.float32)

    return np.nan_to_num(features, nan=0.0, posinf=0.0, neginf=0.0)


_cached_bundle: Optional[dict] = None


def load_audio_model() -> Optional[dict]:
    global _cached_bundle
    if _cached_bundle is not None:
        return _cached_bundle

    if not os.path.exists(MODEL_PATH):
        return None

    checkpoint = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
    model = AudioEmotionNet(
        input_dim=checkpoint["input_dim"],
        num_classes=len(checkpoint["classes"]),
    )
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    _cached_bundle = {
        "model": model,
        "scaler_mean": np.array(checkpoint["scaler_mean"], dtype=np.float32),
        "scaler_scale": np.array(checkpoint["scaler_scale"], dtype=np.float32),
        "classes": checkpoint["classes"],
    }
    return _cached_bundle


def analyze_audio_emotions(audio_bytes: bytes) -> Optional[Tuple[Dict[str, float], float]]:
    """Возвращает словарь вероятностей по 4 классам и confidence (или None, если модель не обучена)."""
    bundle = load_audio_model()
    if bundle is None:
        return None

    y = load_audio_from_bytes(audio_bytes, target_sr=22050)
    feats = extract_features_from_waveform(y, sr=22050)
    feats_scaled = (feats - bundle["scaler_mean"]) / np.where(
        bundle["scaler_scale"] == 0, 1.0, bundle["scaler_scale"]
    )

    with torch.no_grad():
        tensor = torch.tensor(feats_scaled, dtype=torch.float32).unsqueeze(0)
        logits = bundle["model"](tensor)
        probs = torch.softmax(logits, dim=1).squeeze(0).numpy()

    emotions = {cls: round(float(p), 3) for cls, p in zip(bundle["classes"], probs)}
    confidence = round(float(np.max(probs)), 2)
    return emotions, confidence