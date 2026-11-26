import base64
import hashlib
import io
import math
from typing import Dict, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Тёмный базовый фон в цвет карточек MoodVoice (#0a0c16)
BG_COLOR = np.array([10 / 255.0, 12 / 255.0, 22 / 255.0], dtype=np.float32)

# Палитры эмоций (основной + акцентный цвет в диапазоне 0..1)
EMOTION_PALETTES: Dict[str, Tuple[np.ndarray, np.ndarray]] = {
    "calm": (
        np.array([0.23, 0.51, 0.96], dtype=np.float32),  # #3b82f6
        np.array([0.39, 0.40, 0.95], dtype=np.float32),  # #6366f1
    ),
    "joy": (
        np.array([0.06, 0.73, 0.51], dtype=np.float32),  # #10b981
        np.array([0.96, 0.75, 0.22], dtype=np.float32),  # #f5bf38
    ),
    "sadness": (
        np.array([0.55, 0.36, 0.96], dtype=np.float32),  # #8b5cf6
        np.array([0.32, 0.16, 0.62], dtype=np.float32),  # глубокий фиолетовый
    ),
    "stress": (
        np.array([0.98, 0.45, 0.09], dtype=np.float32),  # #f97316
        np.array([0.94, 0.27, 0.27], dtype=np.float32),  # #ef4444
    ),
}


def _make_rng(emotions: Dict[str, float], seed_text: str) -> np.random.Generator:
    raw_seed = (
        f"{seed_text}|"
        f"{emotions.get('calm', 0):.3f}|"
        f"{emotions.get('joy', 0):.3f}|"
        f"{emotions.get('sadness', 0):.3f}|"
        f"{emotions.get('stress', 0):.3f}"
    )
    digest = hashlib.sha256(raw_seed.encode("utf-8")).digest()
    seed_int = int.from_bytes(digest[:8], "big")
    return np.random.default_rng(seed_int)


def _screen_blend(base: np.ndarray, layer: np.ndarray) -> np.ndarray:
    return 1.0 - (1.0 - base) * (1.0 - np.clip(layer, 0.0, 1.0))


def generate_mood_art_image(
    emotions: Dict[str, float],
    seed_text: str = "",
    crisis_detected: bool = False,
    size: int = 512,
) -> Image.Image:
    """Генерирует абстрактное изображение настроения по 4 весам эмоций."""
    rng = _make_rng(emotions, seed_text)

    calm = max(0.0, float(emotions.get("calm", 0.0)))
    joy = max(0.0, float(emotions.get("joy", 0.0)))
    sadness = max(0.0, float(emotions.get("sadness", 0.0)))
    stress = max(0.0, float(emotions.get("stress", 0.0)))

    total = calm + joy + sadness + stress
    if total <= 1e-6:
        calm, joy, sadness, stress = 1.0, 0.0, 0.0, 0.0
    else:
        calm, joy, sadness, stress = calm / total, joy / total, sadness / total, stress / total

    weights = {"calm": calm, "joy": joy, "sadness": sadness, "stress": stress}
    dominant = max(weights, key=weights.get)

    # 1. Вычисляем волновое поле на сетке 256x256 (быстро и мягко после апскейла до 512x512)
    grid = 256
    lin = np.linspace(-1.0, 1.0, grid, dtype=np.float32)
    xx, yy = np.meshgrid(lin, lin)

    # Стресс повышает частоту и турбулентность, спокойствие делает волны широкими и плавными
    freq = 1.7 + 2.4 * stress + 0.5 * joy
    warp_amp = 0.22 + 0.30 * stress + 0.08 * joy

    p1, p2, p3, p4 = rng.uniform(0.0, 2.0 * math.pi, size=4)
    warp_x = (
        0.65 * np.sin(freq * yy + p1) * np.cos(0.8 * freq * xx + p2)
        + 0.35 * np.cos(1.9 * freq * (xx + yy) + p3)
    )
    warp_y = (
        0.65 * np.cos(freq * xx + p2) * np.sin(0.8 * freq * yy + p4)
        + 0.35 * np.sin(1.9 * freq * (xx - yy) + p1)
    )

    wx = xx + warp_amp * warp_x
    wy = yy + warp_amp * warp_y

    canvas = np.broadcast_to(BG_COLOR, (grid, grid, 3)).copy()

    # 2. Накладываем отдельные светящиеся облака для каждой значимой эмоции
    for emotion_key, weight in weights.items():
        if weight < 0.04:
            continue

        primary_col, accent_col = EMOTION_PALETTES[emotion_key]
        cloud_count = 3 if weight >= 0.35 else 2

        for idx in range(cloud_count):
            cx = float(rng.uniform(-0.52, 0.52))
            cy = float(rng.uniform(-0.52, 0.52))
            sigma = float(rng.uniform(0.32, 0.56)) * (0.75 + 0.45 * weight)

            dist2 = (wx - cx) ** 2 + (wy - cy) ** 2
            blob = np.exp(-dist2 / (2.0 * sigma * sigma))

            # Лёгкая текстура «сияния» внутри облака
            angle = float(rng.uniform(0.0, math.pi))
            phase = float(rng.uniform(0.0, 2.0 * math.pi))
            stripe_freq = 2.6 + 3.2 * stress
            proj = wx * math.cos(angle) + wy * math.sin(angle)
            texture = 0.72 + 0.28 * np.sin(stripe_freq * proj + phase)

            color = primary_col if idx % 2 == 0 else accent_col
            intensity = (0.35 + 0.65 * weight) * (0.72 if emotion_key == "sadness" else 0.85)
            mask = np.clip(blob * texture * intensity, 0.0, 0.92)

            layer = mask[..., None] * color[None, None, :]
            canvas = _screen_blend(canvas, layer)

    # При кризисном состоянии добавляем глубокий приглушённый багровый центр
    if crisis_detected:
        crisis_blob = np.exp(-((wx ** 2) + (wy ** 2)) / 0.42) * 0.55
        crisis_col = np.array([0.75, 0.14, 0.18], dtype=np.float32)
        canvas = _screen_blend(canvas * 0.72, crisis_blob[..., None] * crisis_col[None, None, :])

    # 3. Виньетка, чтобы края органично сливались с тёмной карточкой интерфейса
    vignette = np.clip(1.15 - 0.62 * (xx ** 2 + yy ** 2), 0.16, 1.0)
    canvas = BG_COLOR + (canvas - BG_COLOR) * vignette[..., None]

    # Лёгкий плёночный шум для гладкости градиентов (убирает цветовые «ступеньки»)
    grain = rng.normal(0.0, 0.008, size=canvas.shape).astype(np.float32)
    rgb_uint8 = np.clip((canvas + grain) * 255.0, 0, 255).astype(np.uint8)

    base_img = (
        Image.fromarray(rgb_uint8, mode="RGB")
        .resize((size, size), Image.Resampling.BICUBIC)
        .convert("RGBA")
    )

    # 4. Органические «голосовые кольца» в центре (визуальный акцент MoodVoice)
    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sharp_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    sharp_draw = ImageDraw.Draw(sharp_layer)

    ring_color_vec = (
        np.array([0.92, 0.30, 0.32], dtype=np.float32)
        if crisis_detected
        else EMOTION_PALETTES[dominant][0]
    )
    # Высветляем цвет колец, чтобы линии красиво светились на фоне облаков
    ring_rgb = tuple(int(c) for c in np.clip((0.55 * ring_color_vec + 0.45) * 255.0, 0, 255))

    center_x = size * (0.5 + float(rng.uniform(-0.04, 0.04)))
    center_y = size * (0.5 + float(rng.uniform(-0.04, 0.04)))

    ring_count = 4 if stress < 0.45 else 5
    steps = 180
    for r_idx in range(ring_count):
        base_r = size * (0.14 + 0.075 * r_idx)
        k1 = int(rng.integers(2, 4))
        k2 = int(rng.integers(5, 9)) if stress > 0.35 else int(rng.integers(3, 6))
        ph1, ph2 = rng.uniform(0.0, 2.0 * math.pi, size=2)

        amp1 = base_r * (0.06 + 0.12 * stress + 0.05 * joy)
        amp2 = base_r * (0.02 + 0.09 * stress)

        points = []
        for step in range(steps + 1):
            theta = (2.0 * math.pi * step) / steps
            radius = base_r + amp1 * math.sin(k1 * theta + ph1) + amp2 * math.cos(k2 * theta + ph2)
            px = center_x + radius * math.cos(theta)
            py = center_y + radius * math.sin(theta)
            points.append((px, py))

        glow_alpha = max(35, 110 - r_idx * 16)
        sharp_alpha = max(45, 145 - r_idx * 22)
        glow_draw.line(points, fill=(*ring_rgb, glow_alpha), width=5)
        sharp_draw.line(points, fill=(*ring_rgb, sharp_alpha), width=2)

    # 5. Светящиеся частицы (больше при радости и спокойствии)
    particle_count = int(10 + 36 * joy + 14 * calm)
    for _ in range(particle_count):
        px = float(rng.uniform(size * 0.12, size * 0.88))
        py = float(rng.uniform(size * 0.12, size * 0.88))
        rad = float(rng.uniform(1.5, 4.0 + 2.5 * joy))
        alpha = int(rng.integers(75, 185))
        glow_draw.ellipse([px - rad * 2.2, py - rad * 2.2, px + rad * 2.2, py + rad * 2.2], fill=(*ring_rgb, alpha // 2))
        sharp_draw.ellipse([px - rad, py - rad, px + rad, py + rad], fill=(255, 255, 255, alpha))

    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=6))
    composed = Image.alpha_composite(base_img, glow_layer)
    composed = Image.alpha_composite(composed, sharp_layer)

    return composed.convert("RGB")


def generate_mood_art_png_bytes(
    emotions: Dict[str, float],
    seed_text: str = "",
    crisis_detected: bool = False,
    size: int = 512,
) -> bytes:
    img = generate_mood_art_image(emotions, seed_text=seed_text, crisis_detected=crisis_detected, size=size)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def generate_mood_art_base64(
    emotions: Dict[str, float],
    seed_text: str = "",
    crisis_detected: bool = False,
    size: int = 512,
) -> str:
    """Возвращает компактный Data URI (JPEG ~25-40 КБ) для JSON-ответа и тега <img>."""
    img = generate_mood_art_image(emotions, seed_text=seed_text, crisis_detected=crisis_detected, size=size)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"