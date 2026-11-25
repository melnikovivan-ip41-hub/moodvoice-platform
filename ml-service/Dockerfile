FROM python:3.11-slim

WORKDIR /app

# Системная библиотека для чтения WAV через soundfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Отдельный слой под CPU-версию PyTorch (кэшируется при пересборках кода)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем исходники и обученную акустическую модель
COPY main.py emotion_text.py emotion_audio.py ./
COPY models/ ./models/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]