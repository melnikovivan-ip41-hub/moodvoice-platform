# MoodVoice — голосовий щоденник емоційної рефлексії з гібридним AI-аналізом

Вебзастосунок для запису голосових нотаток, автоматичної транскрипції, мультимодального аналізу емоційного стану (текст + акустика голосу), генерації візуального арту настрою та відстеження динаміки емоцій із фокусом на безпеку персональних даних та відмовостійкість.

> **Важливо:** сервіс призначений виключно для саморефлексії та **не є медичним діагнозом** або заміною професійної психологічної допомоги.

---

## Основні можливості

- **Запис та захищене зберігання голосу:** запис аудіо безпосередньо в браузері з підтримкою **паузи / продовження**, автоматичним лімітом тривалості (**5 хвилин**) та розміру (**25 МБ**), шифруванням файлів алгоритмом **AES-256** (`.enc`) та дешифруванням «на льоту» в пам'яті без створення відкритих копій на диску.
- **Асинхронна обробка та відмовостійкість (`@Async`):** завантаження та шифрування аудіо виконуються миттєво зі статусом `PENDING`, а AI-аналіз запускається у фоновому потоці (`AudioProcessingService`) з автоматичним опитуванням (polling) на фронтенді. Якщо ML-сервіс тимчасово недоступний, зашифрований запис зберігається зі статусом `FAILED` і може бути повторно оброблений пізніше кнопкою **«Повторити аналіз»** (`POST /api/audio/{id}/retry`).
- **Демо-режим для гостя:** можливість протестувати голосовий запис та отримати AI-аналіз без реєстрації (`POST /api/audio/demo`) — аудіо та результати не зберігаються в БД чи на диску.
- **Гібридний AI-аналіз емоцій:**
  - розпізнавання українського та англійського мовлення через **Whisper (`whisper-large-v3`)**;
  - класифікація тексту за допомогою **mDeBERTa-v3** (`MoritzLaurer/mDeBERTa-v3-base-mnli-xnli`);
  - акустичний аналіз інтонації (MFCC + власна нейромережа **PyTorch**, навчена скриптом `train_audio_model.py`);
  - об'єднання результатів через адаптивний **Late Fusion** за 4 категоріями: *Спокій*, *Радість*, *Сум*, *Стрес / Тривога*.
- **Виявлення змішаних і кризових станів:** автоматичне попередження при низькій впевненості моделі та відображення контактів екстреної психологічної підтримки (**7333**, **0 800 500 335**) у разі детекції кризових маркерів.
- **Візуалізація та аналітика:** генерація унікального арту настрою, AI-рефлексія, графік динаміки емоцій (**Chart.js**) з перемиканням періодів (**7 днів / 30 днів / Усі**), **календар настрою** (середня домінуюча емоція дня), зведені показники (всього записів, серія днів, за 7 днів), повнотекстовий пошук за транскрипціями та фільтрація архіву.
- **Безпека, згода та GDPR:** автентифікація через **JWT з ротацією refresh-токенів** (access — 1 год, refresh — 7 днів), хешування паролів **BCrypt**, рольовий доступ **RBAC** (`USER`, `ADMIN`), явна згода користувача при реєстрації та перед першим записом, можливість повного безповоротного видалення акаунту разом із зашифрованими аудіозаписами.
- **Адмін-панель:** анонімна агрегована статистика емоцій системи, лічильник кризових записів, керування користувачами (блокування / розблокування). Адміністратор не має доступу до особистих аудіозаписів та транскрипцій користувачів.

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
│  JWT + Refresh / BCrypt      │
│  AES-256 / @Async Queue      │     ┌───────────────────────────────┐
└──────────────┬───────────────┘     │  Docker Volume: audio_uploads │
               ├────────────────────▶│  Зашифровані .enc-аудіофайли  │
               │ (@Async background) └───────────────────────────────┘
               ▼
┌──────────────────────────────┐
│  moodvoice-ml (FastAPI)      │  Groq Whisper API + mDeBERTa-v3 + PyTorch (MFCC) + Art
└──────────────────────────────┘
```

| Сервіс | Контейнер | Порт (хост → контейнер) | Стек |
| :--- | :--- | :--- | :--- |
| **Frontend** | `moodvoice-frontend` | `3000 → 80` | HTML5, CSS3, Vanilla JS, Chart.js, Nginx 1.27 |
| **Backend** | `moodvoice-backend` | `8080 → 8080` | Java 21, Spring Boot (`@Async`), Spring Security, JPA/Hibernate, Maven |
| **ML Service** | `moodvoice-ml` | `8000 → 8000` | Python 3.11, FastAPI, Uvicorn, PyTorch, Transformers, FFmpeg |
| **Database** | `moodvoice-db` | `5435 → 5432` | PostgreSQL 16 Alpine |

---

## Структура проєкту

```text
MoodvoiceCourse/
├── Backend/                 # Spring Boot REST API, Security (JWT/Refresh/BCrypt), AES-256, @Async
│   ├── src/
│   ├── pom.xml
│   ├── Dockerfile
│   └── .dockerignore
├── Frontend/                # SPA-інтерфейс, Chart.js графіки, календар настрою, конфіг Nginx
│   ├── index.html
│   ├── style.css
│   ├── script1.js
│   ├── nginx.conf
│   └── Dockerfile
├── ml-service/              # FastAPI мікросервіс транскрипції, NLP/акустики та генерації арту
│   ├── main.py
│   ├── emotion_text.py
│   ├── emotion_audio.py
│   ├── mood_art.py
│   ├── train_audio_model.py # Скрипт навчання акустичної PyTorch-моделі (RAVDESS + TESS)
│   ├── models/              # Збережені ваги акустичної моделі
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
git clone [https://github.com/melnikovivan-ip41-hub/moodvoice-platform](https://github.com/melnikovivan-ip41-hub/moodvoice-platform)
cd moodvoice-platform
cp .env.example .env
```

Відкрийте створений файл `.env` та вкажіть свій ключ у полі `OPENAI_API_KEY`:

```properties
POSTGRES_PASSWORD=postgres
OPENAI_API_KEY=your_groq_api_key_here
OPENAI_BASE_URL=[https://api.groq.com/openai/v1](https://api.groq.com/openai/v1)
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

# Тест відмовостійкості: зупинка та повторний запуск ML-сервісу
docker compose stop ml-service
docker compose start ml-service

# Зупинка контейнерів (дані БД, аудіо та кеш моделі зберігаються у volumes)
docker compose down

# Повне очищення разом із даними БД та томами
docker compose down -v
```

---

## Основні API-ендпоінти

| Метод | Ендпоінт | Доступ | Опис |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Публічний | Реєстрація користувача, видача `token` та `refreshToken` |
| `POST` | `/api/auth/login` | Публічний | Вхід та отримання пари `token` + `refreshToken` |
| `POST` | `/api/auth/refresh` | Публічний | Оновлення пари JWT-токенів за чинним `refreshToken` |
| `GET` | `/api/auth/me` | `USER` / `ADMIN` | Дані поточного профілю та кількість записів |
| `DELETE` | `/api/auth/account` | `USER` / `ADMIN` | Повне видалення акаунту та всіх `.enc`-файлів (GDPR) |
| `POST` | `/api/audio/demo` | Публічний | Демо-аналіз голосу для гостя без збереження в БД та на диск |
| `POST` | `/api/audio/upload` | `USER` / `ADMIN` | Завантаження, шифрування (AES-256) та запуск фонового `@Async`-аналізу (`202 Accepted`) |
| `GET` | `/api/audio/status/{id}` | `USER` / `ADMIN` | Перевірка статусу обробки запису (`PENDING` / `COMPLETED` / `FAILED`) |
| `POST` | `/api/audio/{id}/retry` | `USER` / `ADMIN` | Повторний запуск фонового AI-аналізу для запису зі статусом `FAILED` |
| `GET` | `/api/audio/play/{id}` | `USER` / `ADMIN` | Потокове відтворення з дешифруванням AES-256 «на льоту» |
| `GET` | `/api/audio/history` | `USER` / `ADMIN` | Отримання історії записів користувача |
| `DELETE` | `/api/audio/delete/{id}` | `USER` / `ADMIN` | Видалення окремого запису та зашифрованого файлу |
| `GET` | `/api/admin/metrics` | `ADMIN` | Агрегована анонімна статистика системи |
| `GET` | `/api/admin/users` | `ADMIN` | Список користувачів системи |
| `PATCH` | `/api/admin/users/{id}/block` | `ADMIN` | Блокування / розблокування користувача |