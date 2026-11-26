# MoodVoice — голосовий щоденник емоційної рефлексії з гібридним AI-аналізом

Вебзастосунок для запису голосових нотаток, автоматичної транскрипції, мультимодального аналізу емоційного стану (текст + акустика голосу), генерації візуального арту настрою та відстеження динаміки емоцій із фокусом на безпеку персональних даних.

---

## Основні можливості

- **Запис та захищене зберігання голосу:** запис аудіо безпосередньо в браузері, шифрування файлів алгоритмом **AES-256** (`.enc`) та дешифрування «на льоту» під час відтворення.
- **Гібридний AI-аналіз емоцій:**
  - розпізнавання українського мовлення через **Whisper (`whisper-large-v3`)**;
  - класифікація тексту за допомогою **mDeBERTa-v3** (`MoritzLaurer/mDeBERTa-v3-base-mnli-xnli`);
  - акустичний аналіз інтонації (MFCC + нейромережа **PyTorch**);
  - об'єднання результатів через адаптивний **Late Fusion** за 4 категоріями: *Спокій*, *Радість*, *Сум*, *Стрес / Тривога*.
- **Виявлення змішаних і кризових станів:** автоматичне попередження при низькій впевненості моделі та відображення контактів екстреної психологічної підтримки (**7333**, **0 800 500 335**) у разі детекції кризових маркерів.
- **Візуалізація та аналітика:** генерація унікального арту настрою, AI-рефлексія, графік динаміки емоцій (**Chart.js**), повнотекстовий пошук за транскрипціями та фільтрація архіву.
- **Безпека та GDPR:** автентифікація через **JWT**, хешування паролів **BCrypt**, рольовий доступ **RBAC** (`USER`, `ADMIN`), можливість повного безповоротного видалення акаунту разом із зашифрованими аудіозаписами.
- **Адмін-панель:** анонімна агрегована статистика емоцій системи, лічильник кризових записів, керування користувачами (блокування / розблокування).

---

## Архітектура та технологічний стек

Система реалізована у вигляді 4 ізольованих Docker-контейнерів:

```text
Browser (http://localhost:3000)
   │
   ▼
┌──────────────────────────────┐
│  moodvoice-frontend (Nginx)  │  Статика (HTML/CSS/JS/Chart.js) + Reverse Proxy /api/
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐     ┌───────────────────────────────┐
│  moodvoice-backend           │────▶│  moodvoice-db (PostgreSQL 16) │
│  (Java 21, Spring Boot)      │     └───────────────────────────────┘
│  JWT / BCrypt / AES-256      │
└──────────────┬───────────────┘     ┌───────────────────────────────┐
               │                     │  Docker Volume: audio_uploads │
               ├────────────────────▶│  Зашифровані .enc-аудіофайли  │
               │                     └───────────────────────────────┘
               ▼
┌──────────────────────────────┐
│  moodvoice-ml (FastAPI)      │  Groq Whisper API + mDeBERTa-v3 + PyTorch (MFCC) + Art
└──────────────────────────────┘
```

| Сервіс | Контейнер | Порт (хост → контейнер) | Стек |
| :--- | :--- | :--- | :--- |
| **Frontend** | `moodvoice-frontend` | `3000 → 80` | HTML5, CSS3, Vanilla JS, Chart.js, Nginx 1.27 |
| **Backend** | `moodvoice-backend` | `8080 → 8080` | Java 21, Spring Boot, Spring Security, JPA/Hibernate, Maven |
| **ML Service** | `moodvoice-ml` | `8000 → 8000` | Python 3.11, FastAPI, Uvicorn, PyTorch, Transformers, FFmpeg |
| **Database** | `moodvoice-db` | `5435 → 5432` | PostgreSQL 16 Alpine |

---

## Структура проєкту

```text
MoodvoiceCourse/
├── Backend/                 # Spring Boot REST API, Security (JWT/BCrypt), AES-256 шифрування
│   ├── src/
│   ├── pom.xml
│   ├── Dockerfile
│   └── .dockerignore
├── Frontend/                # SPA-інтерфейс, Chart.js графіки, конфіг Nginx
│   ├── index.html
│   ├── style.css
│   ├── script1.js
│   ├── nginx.conf
│   └── Dockerfile
├── ml-service/              # FastAPI мікросервіс транскрипції, NLP/акустики та генерації арту
│   ├── main.py
│   ├── emotion_text.py
│   ├── emotion_audio.py
│   ├── models/
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .dockerignore
├── docker-compose.yml       # Оркестрація всіх 4 сервісів та volumes
├── .env.example             # Шаблон змінних середовища
└── README.md
```

---

## Швидкий запуск через Docker

### Передумови
- Встановлений та запущений **Docker Desktop** (з підтримкою Docker Compose v2).
- API-ключ **Groq** для роботи Whisper (`whisper-large-v3`).

### 1. Клонування репозиторію та налаштування `.env`

```bash
git clone https://github.com/melnikovivan-ip41-hub/moodvoice-platform
cd moodvoice-platform
cp .env.example .env
```

Відкрийте створений файл `.env` та вкажіть свій ключ у полі `OPENAI_API_KEY`:

```properties
POSTGRES_PASSWORD=postgres
OPENAI_API_KEY=your_groq_api_key_here
OPENAI_BASE_URL=https://api.groq.com/openai/v1
WHISPER_MODEL=whisper-large-v3
AES_SECRET_KEY=TW9vZFZvaWNlMjAyNlNlY3VyZUFFUzI1NktleUZvckF1ZGlvIQ==
JWT_SECRET=TW9vZFZvaWNlMjAyNkpXVFNlY3JldEtleUZvckF1dGhlbnRpY2F0aW9uIQ==
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

### 2. Збірка та запуск

```bash
docker compose up --build -d
```

> **Примітка:** перша збірка триває ~3–5 хвилин (встановлення залежностей Maven/PyTorch та завантаження ваг `mDeBERTa-v3` у постійний том `hf_cache`). Подальші запуски командою `docker compose up -d` займають ~15–20 секунд.

### 3. Доступ до застосунку

- **Вебінтерфейс:** `http://localhost:3000`
- **Backend API:** `http://localhost:8080`
- **ML-сервіс (Swagger UI):** `http://localhost:8000/docs`

**Тестовий обліковий запис адміністратора** (створюється автоматично під час першого старту):
- **Email:** `moodadmin@kpi.ua`
- **Пароль:** `Admin1234`

---

## Корисні команди Docker

```bash
# Перегляд логів усіх сервісів у реальному часі
docker compose logs -f

# Перегляд логів окремого сервісу (backend / ml-service / frontend / db)
docker compose logs --tail=50 ml-service

# Зупинка контейнерів (дані БД, аудіо та кеш моделі зберігаються у volumes)
docker compose down

# Повне очищення разом із даними БД та томами
docker compose down -v
```

---

## Основні API-ендпоінти

| Метод | Ендпоінт | Доступ | Опис |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Публічний | Реєстрація нового користувача |
| `POST` | `/api/auth/login` | Публічний | Вхід та отримання JWT-токена |
| `DELETE` | `/api/auth/account` | `USER` / `ADMIN` | Повне видалення акаунту та всіх `.enc`-файлів (GDPR) |
| `POST` | `/api/audio/upload` | `USER` / `ADMIN` | Завантаження, шифрування (AES-256) та AI-аналіз запису |
| `GET` | `/api/audio/history` | `USER` / `ADMIN` | Отримання історії записів користувача |
| `DELETE` | `/api/audio/delete/{id}` | `USER` / `ADMIN` | Видалення окремого запису та зашифрованого файлу |
| `GET` | `/api/admin/metrics` | `ADMIN` | Агрегована анонімна статистика системи |
| `GET` | `/api/admin/users` | `ADMIN` | Список користувачів системи |
| `PATCH` | `/api/admin/users/{id}/block` | `ADMIN` | Блокування / розблокування користувача |