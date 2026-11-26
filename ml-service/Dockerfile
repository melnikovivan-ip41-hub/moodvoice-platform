FROM python:3.11-slim

WORKDIR /app

# Системні бібліотеки для читання WAV/WebM/MP3
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Окремий шар під CPU-версію PyTorch (кешується при перезбірках коду)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копіюємо всі Python-модулі (включно з генерацією арту) та навчену модель
COPY *.py ./
COPY models/ ./models/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]