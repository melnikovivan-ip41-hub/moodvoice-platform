import re
from typing import Dict, List, Optional, Tuple
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

# Контрастные связки: с них всегда начинаем отдельный фрагмент, чтобы NLI не зануляла предыдущую эмоцию
CONTRAST_START_RE = re.compile(
    r"^(?:але|проте|однак|хоча|зате|натомість|втім|та\s+все\s+ж)\b",
    re.IGNORECASE,
)

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


def _split_into_chunks(text: str, max_chars: int = 220) -> List[str]:
    """Разбивает длинный монолог на смысловые фрагменты с разрывом по контрастным связкам."""
    cleaned = text.strip()
    sentences = [
        s.strip()
        for s in re.split(
            r"(?<=[.!?…])\s+|(?=\b(?:Але|Проте|Однак|Хоча|Зате|Втім)\b)",
            cleaned,
        )
        if s.strip()
    ]
    if len(sentences) <= 1:
        return [cleaned]

    chunks: List[str] = []
    current = ""

    for sentence in sentences:
        is_contrast = bool(CONTRAST_START_RE.match(sentence))
        if not current:
            current = sentence
        elif is_contrast or (len(current) + 1 + len(sentence) > max_chars):
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}"

    if current:
        chunks.append(current)

    return chunks


def _score_single_chunk(clf, chunk: str) -> Tuple[Dict[str, float], float]:
    result = clf(
        chunk,
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
        return {"calm": 1.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}, 0.0

    normalized = {k: raw_scores[k] / total for k in CORE_ORDER}
    return normalized, raw_max


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
    chunks = _split_into_chunks(text)

    weighted_sum = {k: 0.0 for k in CORE_ORDER}
    total_weight = 0.0
    max_raw_peak = 0.0

    for chunk in chunks:
        chunk_probs, chunk_peak = _score_single_chunk(clf, chunk)
        weight = float(max(len(chunk), 1))
        for k in CORE_ORDER:
            weighted_sum[k] += chunk_probs[k] * weight
        total_weight += weight
        if chunk_peak > max_raw_peak:
            max_raw_peak = chunk_peak

    if total_weight <= 1e-6:
        return {"calm": 1.0, "joy": 0.0, "sadness": 0.0, "stress": 0.0}, 0.0, True

    normalized = {k: round(weighted_sum[k] / total_weight, 3) for k in CORE_ORDER}
    confidence = round(max(normalized.values()), 2)
    is_low_confidence = (confidence < 0.40) or (max_raw_peak < 0.35)

    return normalized, confidence, is_low_confidence