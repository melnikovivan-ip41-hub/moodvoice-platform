import re
from typing import Dict, Optional, Tuple
from transformers import pipeline

MODEL_NAME = "AnasAlokla/multilingual_go_emotions"

# Маппинг всех 28 классов GoEmotions в 4 базовых состояния MoodVoice
GOEMOTIONS_TO_CORE = {
    # Спокій (calm)
    "neutral": "calm",
    "relief": "calm",
    "approval": "calm",
    "caring": "calm",
    "realization": "calm",
    "curiosity": "calm",
    # Радість (joy)
    "joy": "joy",
    "admiration": "joy",
    "amusement": "joy",
    "excitement": "joy",
    "gratitude": "joy",
    "love": "joy",
    "optimism": "joy",
    "pride": "joy",
    "desire": "joy",
    "surprise": "joy",
    # Смуток (sadness)
    "sadness": "sadness",
    "disappointment": "sadness",
    "grief": "sadness",
    "remorse": "sadness",
    "embarrassment": "sadness",
    # Стрес / Тривога (stress)
    "anger": "stress",
    "annoyance": "stress",
    "disapproval": "stress",
    "disgust": "stress",
    "fear": "stress",
    "nervousness": "stress",
    "confusion": "stress",
}

MOOD_LABELS_UK = {
    "calm": "Спокій",
    "joy": "Радість",
    "sadness": "Смуток",
    "stress": "Тривога / Стрес",
}

CRISIS_PATTERNS = [
    r"не\s+хочу\s+жити",
    r"покінчити\s+з\s+собою",
    r"накласти\s+на\s+себе\s+руки",
    r"суїцид",
    r"самогубств",
    r"немає\s+сенсу\s+жити",
    r"вбити\s+себе",
    r"заподіяти\s+собі\s+шкод",
    r"kill\s+myself",
    r"end\s+my\s+life",
    r"want\s+to\s+die",
    r"suicide",
    r"self[- ]?harm",
]

CRISIS_SUPPORT_MESSAGE = (
    "Схоже, ви зараз переживаєте дуже складний емоційний стан. "
    "MoodVoice не замінює професійну медичну чи психологічну допомогу. "
    "Будь ласка, зверніться на цілодобову безкоштовну лінію підтримки Lifeline Ukraine за номером 7333 "
    "або за єдиним номером екстреної допомоги 112."
)

_classifier = None


def get_text_classifier():
    global _classifier
    if _classifier is None:
        print(f"Завантаження NLP-моделі {MODEL_NAME}...")
        _classifier = pipeline(
            "text-classification",
            model=MODEL_NAME,
            top_k=None,
            truncation=True,
            max_length=512,
            device=-1,
        )
        print("NLP-модель готова.")
    return _classifier


def detect_crisis(text: str) -> Tuple[bool, Optional[str]]:
    lowered = text.lower()
    for pattern in CRISIS_PATTERNS:
        if re.search(pattern, lowered):
            return True, CRISIS_SUPPORT_MESSAGE
    return False, None


def analyze_text_emotions(text: str) -> Tuple[Dict[str, float], float, bool]:
    """
    Возвращает:
      - словарь вероятностей по 4 классам (сумма = 1.0)
      - confidence (уверенность в доминирующей эмоции)
      - is_low_confidence (True, если текста нет или модель не уверена)
    """
    if not text or len(text.strip()) < 3:
        return {"calm": 1.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}, 0.0, True

    clf = get_text_classifier()
    raw_output = clf(text)
    if raw_output and isinstance(raw_output[0], list):
        raw_output = raw_output[0]

    # Берем максимум в каждой группе, чтобы группы с большим числом меток не перетягивали вес
    bucket_peaks = {"calm": 0.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}
    for item in raw_output:
        label = item["label"].lower()
        score = float(item["score"])
        core_emotion = GOEMOTIONS_TO_CORE.get(label)
        if core_emotion and score > bucket_peaks[core_emotion]:
            bucket_peaks[core_emotion] = score

    raw_max = max(bucket_peaks.values())
    total = sum(bucket_peaks.values())

    if total <= 1e-6:
        return {"calm": 1.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}, 0.0, True

    normalized = {k: round(v / total, 3) for k, v in bucket_peaks.items()}
    confidence = round(max(normalized.values()), 2)
    is_low_confidence = (confidence < 0.45) or (raw_max < 0.20)

    return normalized, confidence, is_low_confidence