import re
from typing import Dict, Optional, Tuple
from transformers import pipeline

MODEL_NAME = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"

# Описания 4 базовых состояний для Zero-Shot NLI на украинском
LABEL_TO_CORE = {
    "спокій, затишок, врівноваженість і відпочинок": "calm",
    "радість, щастя, вдячність і задоволення": "joy",
    "сум, втому, пригніченість і розчарування": "sadness",
    "стрес, тривогу, роздратування і злість": "stress",
}

CANDIDATE_LABELS = list(LABEL_TO_CORE.keys())
HYPOTHESIS_TEMPLATE = "У цьому тексті людина відчуває {}."
CORE_ORDER = ("calm", "joy", "sadness", "stress")

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
            "zero-shot-classification",
            model=MODEL_NAME,
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
    result = clf(
        text.strip(),
        candidate_labels=CANDIDATE_LABELS,
        hypothesis_template=HYPOTHESIS_TEMPLATE,
        multi_label=True,
    )

    raw_scores = {k: 0.0 for k in CORE_ORDER}
    for label, score in zip(result["labels"], result["scores"]):
        core_key = LABEL_TO_CORE.get(label)
        if core_key:
            raw_scores[core_key] = float(score)

    raw_max = max(raw_scores.values())
    total = sum(raw_scores.values())
    if total <= 1e-6:
        return {"calm": 1.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}, 0.0, True

    normalized = {k: round(raw_scores[k] / total, 3) for k in CORE_ORDER}
    confidence = round(max(normalized.values()), 2)
    is_low_confidence = (confidence < 0.40) or (raw_max < 0.35)

    return normalized, confidence, is_low_confidence