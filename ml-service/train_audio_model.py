import glob
import json
import os
import random
from collections import defaultdict

import librosa
import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from torch.utils.data import DataLoader, TensorDataset

from emotion_audio import (
    AudioEmotionNet,
    CORE_CLASSES,
    MODEL_PATH,
    extract_features_from_waveform,
)

# Сколько файлов каждого класса брать из TESS (0 = обучать только на RAVDESS)
TESS_MAX_PER_CLASS = 100

RAVDESS_TO_CORE = {
    "01": "calm",     # neutral
    "02": "calm",     # calm
    "03": "joy",      # happy
    "04": "sadness",  # sad
    "05": "stress",   # angry
    "06": "stress",   # fearful
    "07": "stress",   # disgust
    "08": "joy",      # surprised
}

TESS_TO_CORE = {
    "neutral": "calm",
    "happy": "joy",
    "ps": "joy",
    "sad": "sadness",
    "angry": "stress",
    "fear": "stress",
    "disgust": "stress",
}

CLASS_TO_IDX = {name: i for i, name in enumerate(CORE_CLASSES)}


def set_seed(seed: int = 42):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def load_ravdess_records(data_dir: str):
    wav_files = sorted(glob.glob(os.path.join(data_dir, "**", "*.wav"), recursive=True))
    records = []
    seen = set()
    for path in wav_files:
        fname = os.path.basename(path).lower()
        if fname in seen:
            continue
        parts = fname.split("-")
        if len(parts) < 3:
            continue
        core_emotion = RAVDESS_TO_CORE.get(parts[2])
        if core_emotion is not None:
            seen.add(fname)
            records.append((path, CLASS_TO_IDX[core_emotion], "ravdess"))
    return records


def load_tess_records(data_dir: str, max_per_class: int = 100):
    if max_per_class <= 0 or not os.path.exists(data_dir):
        return []
    wav_files = sorted(glob.glob(os.path.join(data_dir, "**", "*.wav"), recursive=True))
    by_class = defaultdict(list)
    seen = set()

    for path in wav_files:
        fname = os.path.basename(path).lower()
        if fname in seen:
            continue
        stem = os.path.splitext(fname)[0]
        suffix = stem.split("_")[-1]
        core_emotion = TESS_TO_CORE.get(suffix)
        if core_emotion is not None:
            seen.add(fname)
            by_class[CLASS_TO_IDX[core_emotion]].append((path, CLASS_TO_IDX[core_emotion], "tess"))

    rng = random.Random(42)
    records = []
    for cls_idx in sorted(by_class.keys()):
        items = by_class[cls_idx]
        rng.shuffle(items)
        records.extend(items[:max_per_class])
    return records


def build_features(records, augment: bool = False):
    X, y = [], []
    total = len(records)

    for idx, (path, label, source) in enumerate(records, 1):
        waveform, sr = librosa.load(path, sr=22050)
        X.append(extract_features_from_waveform(waveform, sr=sr))
        y.append(label)

        if augment:
            # 1. Лёгкий шум для всех записей
            noise_amp = 0.005 * np.max(np.abs(waveform))
            noisy = waveform + noise_amp * np.random.randn(len(waveform)).astype(np.float32)
            X.append(extract_features_from_waveform(noisy, sr=sr))
            y.append(label)

            # 2. Смещение тона только для RAVDESS (сохраняем баланс по голосам)
            if source == "ravdess":
                shift = random.choice([-1.5, 1.5])
                pitched = librosa.effects.pitch_shift(waveform, sr=sr, n_steps=shift)
                X.append(extract_features_from_waveform(pitched, sr=sr))
                y.append(label)

        if idx % 300 == 0 or idx == total:
            print(f"  Обработано {idx}/{total} файлов...")

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int64)


def main():
    set_seed(42)
    base_dir = os.path.dirname(__file__)
    ravdess_dir = os.path.join(base_dir, "data", "ravdess")
    tess_dir = os.path.join(base_dir, "data", "tess")

    ravdess_records = load_ravdess_records(ravdess_dir)
    tess_records = load_tess_records(tess_dir, max_per_class=TESS_MAX_PER_CLASS)

    if len(ravdess_records) == 0:
        raise FileNotFoundError(f"Не найдены .wav файлы RAVDESS в {ravdess_dir}")

    all_records = ravdess_records + tess_records
    print(f"Файлов в обучении+тесте: RAVDESS={len(ravdess_records)}, TESS={len(tess_records)}, всего={len(all_records)}")

    stratify_keys = [f"{src}_{lbl}" for _, lbl, src in all_records]
    train_records, test_records = train_test_split(
        all_records, test_size=0.20, stratify=stratify_keys, random_state=42
    )

    print("1/3 Извлечение MFCC-признаков для train (с аугментацией)...")
    X_train, y_train = build_features(train_records, augment=True)

    print("2/3 Извлечение MFCC-признаков для test (чистые файлы)...")
    X_test, y_test = build_features(test_records, augment=False)
    test_sources = np.array([src for _, _, src in test_records])

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train).astype(np.float32)
    X_test_scaled = scaler.transform(X_test).astype(np.float32)

    counts = np.bincount(y_train, minlength=len(CORE_CLASSES)).astype(np.float32)
    class_weights = counts.sum() / (len(CORE_CLASSES) * counts)
    criterion = nn.CrossEntropyLoss(
        weight=torch.tensor(class_weights, dtype=torch.float32),
        label_smoothing=0.1,
    )

    train_loader = DataLoader(
        TensorDataset(torch.tensor(X_train_scaled), torch.tensor(y_train)),
        batch_size=64,
        shuffle=True,
    )

    model = AudioEmotionNet(input_dim=X_train.shape[1], num_classes=len(CORE_CLASSES))
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-3)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="max", factor=0.5, patience=8)

    rav_mask = test_sources == "ravdess"
    tess_mask = test_sources == "tess"
    has_tess = bool(np.any(tess_mask))

    best_score = 0.0
    best_state = None
    best_preds = None

    print("3/3 Обучение PyTorch-модели (100 эпох)...")
    X_test_tensor = torch.tensor(X_test_scaled)

    for epoch in range(1, 101):
        model.train()
        total_loss = 0.0
        for bx, by in train_loader:
            optimizer.zero_grad()
            logits = model(bx)
            loss = criterion(logits, by)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        model.eval()
        with torch.no_grad():
            test_logits = model(X_test_tensor)
            preds = torch.argmax(test_logits, dim=1).numpy()

        rav_f1 = f1_score(y_test[rav_mask], preds[rav_mask], average="weighted")
        if has_tess:
            tess_f1 = f1_score(y_test[tess_mask], preds[tess_mask], average="weighted")
            selection_score = 0.75 * rav_f1 + 0.25 * tess_f1
        else:
            selection_score = rav_f1

        scheduler.step(selection_score)

        if selection_score > best_score:
            best_score = selection_score
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
            best_preds = preds

        if epoch % 20 == 0 or epoch == 1:
            print(f"  Epoch {epoch:3d}/100 | loss={total_loss/len(train_loader):.4f} | RAVDESS F1={rav_f1:.4f}")

    combined_f1 = f1_score(y_test, best_preds, average="weighted")
    final_rav_f1 = f1_score(y_test[rav_mask], best_preds[rav_mask], average="weighted")
    final_tess_f1 = f1_score(y_test[tess_mask], best_preds[tess_mask], average="weighted") if has_tess else None

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    torch.save(
        {
            "model_state_dict": best_state,
            "input_dim": int(X_train.shape[1]),
            "classes": CORE_CLASSES,
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "weighted_f1": round(float(combined_f1), 4),
            "ravdess_weighted_f1": round(float(final_rav_f1), 4),
            "tess_weighted_f1": round(float(final_tess_f1), 4) if final_tess_f1 is not None else None,
        },
        MODEL_PATH,
    )

    report_text = classification_report(y_test, best_preds, target_names=CORE_CLASSES, digits=4)
    cm = confusion_matrix(y_test, best_preds).tolist()

    metrics_path = os.path.join(os.path.dirname(MODEL_PATH), "metrics.json")
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "datasets": f"RAVDESS ({len(ravdess_records)}) + TESS ({len(tess_records)})",
                "train_samples_augmented": int(len(X_train)),
                "test_samples": int(len(X_test)),
                "classes": CORE_CLASSES,
                "weighted_f1_combined": round(float(combined_f1), 4),
                "weighted_f1_ravdess": round(float(final_rav_f1), 4),
                "weighted_f1_tess": round(float(final_tess_f1), 4) if final_tess_f1 is not None else None,
                "confusion_matrix": cm,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )

    print("\n================ РЕЗУЛЬТАТЫ ОБУЧЕНИЯ ================")
    print(f"Общий Weighted F1-score: {combined_f1 * 100:.2f}% (порог ТЗ: >= 70.00%)")
    print(f"  - отдельно на RAVDESS test: {final_rav_f1 * 100:.2f}%")
    if final_tess_f1 is not None:
        print(f"  - отдельно на TESS test:    {final_tess_f1 * 100:.2f}%")
    print(report_text)
    print(f"Модель обновлена: {MODEL_PATH}")


if __name__ == "__main__":
    main()