let mediaRecorder = null;
let audioChunks = [];
let recordingStopPromise = null;
let timerInterval = null;
let timerSeconds = 0;

// Автовизначення: локально стукаємо в Spring Boot на :8080, на продакшені — в Render
const API_BASE_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.protocol === "file:")
    ? "http://localhost:8080"
    : "https://moodvoice-api.onrender.com";

let userHistoryRecords = [];

// ===== ДОПОМІЖНІ ФУНКЦІЇ =====
function escapeHtml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getMoodMeta(moodType, isCrisis = false) {
    if (isCrisis) {
        return {
            tagClass: "tag-crisis",
            gradient: "radial-gradient(ellipse at center, rgba(239, 68, 68, 0.45) 0%, rgba(127, 29, 29, 0.25) 45%, transparent 75%), var(--bg-card)",
            label: moodType || "Потрібна підтримка"
        };
    }

    const normalized = (moodType || "").toLowerCase();
    if (normalized.includes("рад") || normalized.includes("joy")) {
        return {
            tagClass: "tag-joy",
            gradient: "radial-gradient(ellipse at center, rgba(16, 185, 129, 0.45) 0%, rgba(59, 130, 246, 0.2) 45%, transparent 75%), var(--bg-card)",
            label: moodType
        };
    }
    if (normalized.includes("стрес") || normalized.includes("трив") || normalized.includes("stress")) {
        return {
            tagClass: "tag-anxiety",
            gradient: "radial-gradient(ellipse at center, rgba(249, 115, 22, 0.45) 0%, rgba(239, 68, 68, 0.2) 45%, transparent 75%), var(--bg-card)",
            label: moodType
        };
    }
    if (normalized.includes("смут") || normalized.includes("сум") || normalized.includes("sad")) {
        return {
            tagClass: "tag-sadness",
            gradient: "radial-gradient(ellipse at center, rgba(168, 85, 247, 0.45) 0%, rgba(59, 130, 246, 0.25) 45%, transparent 75%), var(--bg-card)",
            label: moodType
        };
    }
    return {
        tagClass: "tag-calm",
        gradient: "radial-gradient(ellipse at center, rgba(59, 130, 246, 0.45) 0%, rgba(139, 92, 246, 0.2) 45%, transparent 75%), var(--bg-card)",
        label: moodType || "Спокій"
    };
}

function buildReflectionText(record) {
    if (record.crisisDetected) {
        return "Модель зафіксувала ознаки сильного емоційного перевантаження. Будь ласка, не залишайтеся з цим наодинці — зверніться до близьких або на цілодобову лінію підтримки 7333.";
    }

    const mood = (record.moodType || "").toLowerCase();
    if (mood.includes("рад") || mood.includes("joy")) {
        return "У вашому голосі та словах переважають позитивні емоції. Зафіксуйте, що саме подарувало цей ресурс — до таких моментів корисно повертатися у напружені дні.";
    }
    if (mood.includes("стрес") || mood.includes("трив") || mood.includes("stress")) {
        return "Помітний підвищений рівень напруги. Спробуйте зробити коротку паузу: кілька повільних вдихів і видихів або 5 хвилин без екранів допоможуть знизити навантаження.";
    }
    if (mood.includes("смут") || mood.includes("сум") || mood.includes("sad")) {
        return "Відчувається пригнічений або втомлений настрій. Проговорювати такі переживання вголос — вже важливий крок. Дайте собі трохи часу на відпочинок і відновлення.";
    }
    return "Ваш емоційний стан виглядає стабільним і врівноваженим. Продовжуйте фіксувати думки регулярно, щоб відстежувати динаміку настрою.";
}

function calculateStreakDays(records) {
    if (!records || records.length === 0) return 0;

    const uniqueDays = new Set(
        records
            .map(r => r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : null)
            .filter(Boolean)
    );

    const today = new Date();
    let streak = 0;
    let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const formatKey = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    if (!uniqueDays.has(formatKey(cursor))) {
        cursor.setDate(cursor.getDate() - 1);
    }

    while (uniqueDays.has(formatKey(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }

    return streak;
}

// ===== КАСТОМНІ СПОВІЩЕННЯ (ПЛАШКИ) =====
function showNotification(message, type = 'error') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `custom-toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => toast.classList.add('show'), 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

// ===== НАВІГАЦІЯ =====
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    window.scrollTo(0, 0);

    if (screenId === 'recording-screen') {
        startAudioRecording();
    } else {
        stopAudioRecording();
    }

    if (screenId === 'dashboard-screen') {
        loadUserHistory();
    }

    const player = document.querySelector('#custom-audio-player audio');
    if (player && screenId !== 'analytics-screen') {
        player.pause();
    }
}

// ===== АВТОРИЗАЦІЯ =====
async function handleLogin(event) {
    event.preventDefault();

    const submitBtn = event.submitter;
    const originalText = submitBtn.textContent;

    const emailValue = document.getElementById('login-email').value.trim().toLowerCase();
    const passwordValue = document.getElementById('login-password').value;

    if (passwordValue.length === 0 || emailValue.length === 0) {
        showNotification("Будь ласка, заповніть всі поля.", "error");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Завантаження...";

    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: emailValue, password: passwordValue })
        });

        if (response.ok) {
            localStorage.setItem('userEmail', emailValue);
            showNotification("Вхід успішний!", "success");
            showScreen('dashboard-screen');
            document.getElementById('login-email').value = '';
            document.getElementById('login-password').value = '';
        } else {
            showNotification("Неправильний email або пароль.", "error");
        }
    } catch (error) {
        console.error("Сервер недоступний:", error);
        showNotification("Не вдалося підключитися до сервера.", "error");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
}

async function handleRegister(event) {
    event.preventDefault();

    const submitBtn = event.submitter;
    const originalText = submitBtn.textContent;

    const emailValue = document.getElementById('register-email').value.trim().toLowerCase();
    const passwordValue = document.getElementById('register-password').value;

    const emailRegex = /^[a-z0-9._-]{6,30}@(gmail\.com|ukr\.net|kpi\.ua|student\.kpi\.ua)$/;
    if (!emailRegex.test(emailValue)) {
        showNotification("Логін має бути від 6 до 30 символів без спецсимволів. Дозволені домени: @gmail.com, @ukr.net, @kpi.ua", "error");
        return;
    }

    const passwordCheck = validatePassword(passwordValue);
    if (passwordCheck !== "ok") {
        showNotification(passwordCheck, "error");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Зачекайте...";

    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: emailValue, password: passwordValue })
        });

        const data = await response.json();

        if (data.status === "success") {
            localStorage.setItem('userEmail', emailValue);
            showNotification("Реєстрація успішна!", "success");
            showScreen('dashboard-screen');
            document.getElementById('register-email').value = '';
            document.getElementById('register-password').value = '';
        } else {
            showNotification(data.message, "error");
        }
    } catch (error) {
        console.error("Сервер недоступний:", error);
        showNotification("Не вдалося підключитися до сервера.", "error");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
}

function togglePassword(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
}

function validatePassword(password) {
    if (password.length < 8) return "Пароль має містити щонайменше 8 символів.";
    if (!/[A-Z]/.test(password)) return "Пароль має містити хоча б одну велику літеру.";
    if (!/[a-z]/.test(password)) return "Пароль має містити хоча б одну маленьку літеру.";
    if (!/\d/.test(password)) return "Пароль має містити хоча б одну цифру.";
    if (/[^a-zA-Z0-9]/.test(password)) return "Пароль не повинен містити спецсимволів (лише англійські літери та цифри).";
    return "ok";
}

// ===== ЛОГІКА ЗАПИСУ З МІКРОФОНА =====
async function startAudioRecording() {
    audioChunks = [];
    recordingStopPromise = null;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);

        recordingStopPromise = new Promise((resolve) => {
            mediaRecorder.onstop = () => resolve();
        });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.start();
        startTimer();
        updateStopButtonUI(true);
    } catch (err) {
        showNotification("Помилка доступу до мікрофона: " + err.message, "error");
        showScreen('dashboard-screen');
    }
}

async function stopAudioRecording() {
    stopTimer();
    updateStopButtonUI(false);

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        const tracks = mediaRecorder.stream ? mediaRecorder.stream.getTracks() : [];
        mediaRecorder.stop();
        if (recordingStopPromise) {
            await recordingStopPromise;
        }
        tracks.forEach(track => track.stop());
    }
}

function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        stopAudioRecording();
    } else {
        startAudioRecording();
    }
}

function updateStopButtonUI(isRecording) {
    const stopBtn = document.querySelector('.stop-button');
    const hint = document.querySelector('.stop-hint');
    if (!stopBtn) return;

    if (isRecording) {
        stopBtn.style.background = "var(--color-danger)";
        stopBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="white"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
        if (hint) hint.textContent = "Натисніть, щоб зупинити";
    } else {
        stopBtn.style.background = "var(--brand-gradient)";
        stopBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="8"/></svg>';
        if (hint) hint.textContent = "Запис зупинено — натисніть «Зберегти» або почніть заново";
    }
}

function toggleMusic(btn) {
    btn.classList.toggle('playing');
    const textSpan = btn.querySelector('span');
    textSpan.textContent = btn.classList.contains('playing') ? 'Музика грає...' : 'Музика під настрій';
}

// ===== ЛОГІКА ІСТОРІЇ ЗАПИСІВ =====
async function loadUserHistory() {
    const savedEmail = localStorage.getItem('userEmail');
    if (!savedEmail) return;

    const historyList = document.querySelector('.history-list');
    if (!historyList) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/audio/history?email=${encodeURIComponent(savedEmail)}`);
        if (!response.ok) throw new Error('Помилка завантаження історії');

        userHistoryRecords = await response.json();
        historyList.innerHTML = '';

        // Оновлюємо реальну статистику на дашборді
        const totalEl = document.querySelector('[data-testid="stat-records"] .stat-number');
        const streakEl = document.querySelector('[data-testid="stat-streak"] .stat-number');
        const weekEl = document.querySelector('[data-testid="stat-minutes"] .stat-number');
        const weekLabel = document.querySelector('[data-testid="stat-minutes"] .stat-label');

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const lastWeekCount = userHistoryRecords.filter(r => r.createdAt && new Date(r.createdAt).getTime() >= sevenDaysAgo).length;

        if (totalEl) totalEl.textContent = userHistoryRecords.length;
        if (streakEl) streakEl.textContent = calculateStreakDays(userHistoryRecords);
        if (weekEl) weekEl.textContent = lastWeekCount;
        if (weekLabel) weekLabel.textContent = "За 7 днів";

        if (userHistoryRecords.length === 0) {
            historyList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">У вас поки немає записів. Створіть перший!</p>';
            return;
        }

        userHistoryRecords.forEach((record, index) => {
            const dateObj = new Date(record.createdAt);
            const dateStr = dateObj.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
            const timeStr = dateObj.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
            const meta = getMoodMeta(record.moodType, record.crisisDetected);

            const rawText = (record.transcription || "").trim();
            const previewText = rawText.length > 110
                ? escapeHtml(rawText.slice(0, 110)) + "..."
                : escapeHtml(rawText || "Натисніть, щоб відкрити аналітику та прослухати");

            const recordHtml = `
                <div class="history-item" onclick="openAnalytics(${index})">
                    <div class="history-header">
                        <div class="history-meta">
                            <div class="history-date">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                    <line x1="8" y1="2" x2="8" y2="6"/>
                                    <line x1="3" y1="10" x2="21" y2="10"/>
                                </svg>
                                ${dateStr}
                            </div>
                            <div class="history-time">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polyline points="12,6 12,12 16,14"/>
                                </svg>
                                ${timeStr}
                            </div>
                        </div>
                        <span class="mood-tag ${meta.tagClass}">${escapeHtml(meta.label)}</span>
                    </div>
                    <p class="history-preview">${previewText}</p>
                </div>
            `;
            historyList.insertAdjacentHTML('beforeend', recordHtml);
        });
    } catch (error) {
        console.error(error);
        showNotification("Не вдалося завантажити історію записів", "error");
    }
}

function setEmotionBar(testId, score) {
    const item = document.querySelector(`[data-testid="${testId}"]`);
    if (!item) return;

    const percent = Math.max(0, Math.min(100, Math.round((score || 0) * 100)));
    const fill = item.querySelector('.progress-fill');
    const val = item.querySelector('.progress-value');

    if (fill) fill.style.width = `${percent}%`;
    if (val) val.textContent = `${percent}%`;
}

function openAnalytics(indexOrRecord) {
    const record = typeof indexOrRecord === 'number'
        ? userHistoryRecords[indexOrRecord]
        : indexOrRecord;

    if (!record) return;

    showScreen('analytics-screen');

    const dateObj = new Date(record.createdAt);
    const dateStr = dateObj.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = dateObj.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

    document.querySelector('.analytics-date').innerHTML = `
        <span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> ${dateStr}</span>
        <span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg> ${timeStr}</span>
    `;

    // 1. Кризисний банер
    const crisisBanner = document.getElementById('crisis-banner');
    const crisisText = document.getElementById('crisis-banner-text');
    if (crisisBanner) {
        if (record.crisisDetected) {
            crisisBanner.style.display = 'block';
            if (crisisText) {
                crisisText.textContent = record.crisisMessage || "Схоже, зараз вам дуже важко. Зверніться по безкоштовну та конфіденційну підтримку.";
            }
        } else {
            crisisBanner.style.display = 'none';
        }
    }

    // 2. Візуал настрою (mood-art)
    const meta = getMoodMeta(record.moodType, record.crisisDetected);
    const artSection = document.querySelector('.mood-art');
    const artBadge = document.getElementById('mood-art-badge');
    if (artSection) {
        const oldArtImg = document.getElementById('mood-art-img');
        if (oldArtImg) oldArtImg.remove();

        if (record.moodArtBase64) {
            artSection.style.background = "var(--bg-card)";
            const img = document.createElement('img');
            img.id = 'mood-art-img';
            img.className = 'mood-art-img';
            img.src = record.moodArtBase64;
            img.alt = `Арт настрою: ${meta.label}`;
            artSection.prepend(img);
        } else {
            // Fallback-градієнт для старих записів без згенерованого арту
            artSection.style.background = meta.gradient;
        }
    }
    if (artBadge) {
        const confPct = record.confidence != null ? Math.round(record.confidence * 100) : null;
        artBadge.textContent = confPct != null ? `${meta.label} • ${confPct}%` : meta.label;
    }

    // 3. Аудіоплеєр (без жорсткого audio/webm — працює і з mp3, і з webm, і з wav)
    const oldPlayer = document.getElementById('custom-audio-player');
    if (oldPlayer) oldPlayer.remove();

    const playerHtml = `
        <div id="custom-audio-player" class="sleek-player">
            <audio id="real-audio" src="${record.filePath}" preload="metadata" style="display: none;"></audio>

            <button id="play-pause-btn" class="sleek-play-btn">
                <svg id="icon-play" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                <svg id="icon-pause" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>

            <div class="sleek-progress-bg" id="progress-bg">
                <div class="sleek-progress-fill" id="progress-fill"></div>
            </div>

            <div class="sleek-time" id="time-display">0:00</div>
        </div>
    `;
    artSection.insertAdjacentHTML('beforebegin', playerHtml);

    const audioEl = document.getElementById('real-audio');
    const playBtn = document.getElementById('play-pause-btn');
    const iconPlay = document.getElementById('icon-play');
    const iconPause = document.getElementById('icon-pause');
    const progressBg = document.getElementById('progress-bg');
    const progressFill = document.getElementById('progress-fill');
    const timeDisplay = document.getElementById('time-display');

    const formatTime = (time) => {
        if (!isFinite(time) || isNaN(time)) return "0:00";
        const m = Math.floor(time / 60);
        const s = Math.floor(time % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    audioEl.onloadedmetadata = () => {
        if (isFinite(audioEl.duration)) {
            timeDisplay.textContent = `0:00 / ${formatTime(audioEl.duration)}`;
        }
    };

    playBtn.onclick = () => {
        if (audioEl.paused) {
            audioEl.play().catch(err => showNotification("Не вдалося відтворити аудіо: " + err.message, "error"));
            iconPlay.style.display = 'none';
            iconPause.style.display = 'block';
        } else {
            audioEl.pause();
            iconPlay.style.display = 'block';
            iconPause.style.display = 'none';
        }
    };

    audioEl.ontimeupdate = () => {
        if (isFinite(audioEl.duration) && audioEl.duration > 0) {
            const percent = (audioEl.currentTime / audioEl.duration) * 100;
            progressFill.style.width = `${percent}%`;
            timeDisplay.textContent = `${formatTime(audioEl.currentTime)} / ${formatTime(audioEl.duration)}`;
        } else {
            timeDisplay.textContent = formatTime(audioEl.currentTime);
        }
    };

    progressBg.onclick = (e) => {
        if (!isFinite(audioEl.duration) || !audioEl.duration) return;
        const rect = progressBg.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audioEl.currentTime = percent * audioEl.duration;
    };

    audioEl.onended = () => {
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        progressFill.style.width = '0%';
    };

    // 4. Кнопка видалення та збереження арту
    const deleteBtn = document.querySelector('[data-testid="delete-btn"]');
    if (deleteBtn) {
        deleteBtn.onclick = () => deleteRecord(record.id);
    }

    const shareBtn = document.querySelector('[data-testid="share-btn"]');
    if (shareBtn) {
        shareBtn.onclick = () => {
            if (!record.moodArtBase64) {
                showNotification("Арт доступний лише для нових записів.", "error");
                return;
            }
            const link = document.createElement('a');
            link.href = record.moodArtBase64;
            link.download = `moodvoice-art-${record.id || Date.now()}.jpg`;
            link.click();
            showNotification("Арт настрою збережено!", "success");
        };
    }

    // 5. Транскрипція
    const transcriptionBox = document.querySelector('[data-testid="transcription-text"]');
    if (transcriptionBox) {
        transcriptionBox.textContent = record.transcription || "Мовлення не розпізнано або запис був занадто тихим.";
    }

    // 6. Реальні 4 шкали емоцій + впевненість
    setEmotionBar('emotion-calm', record.calmScore);
    setEmotionBar('emotion-joy', record.joyScore);
    setEmotionBar('emotion-sadness', record.sadnessScore);
    setEmotionBar('emotion-stress', record.stressScore);

    const confBadge = document.getElementById('confidence-badge');
    if (confBadge) {
        confBadge.textContent = record.confidence != null
            ? `Впевненість AI: ${Math.round(record.confidence * 100)}%`
            : '';
    }

    const lowConfNote = document.getElementById('low-confidence-note');
    if (lowConfNote) {
        lowConfNote.style.display = record.isLowConfidence ? 'block' : 'none';
    }

    // 7. Рефлексія та теги
    const reflectionTextEl = document.getElementById('reflection-text');
    if (reflectionTextEl) {
        reflectionTextEl.textContent = buildReflectionText(record);
    }

    const reflectionTags = document.querySelector('.reflection-tags');
    if (reflectionTags) {
        reflectionTags.innerHTML = `<span class="mood-tag ${meta.tagClass}">${escapeHtml(meta.label)}</span>`;
        if (record.isLowConfidence) {
            reflectionTags.insertAdjacentHTML('beforeend', `<span class="mood-tag tag-anxiety">Змішані емоції</span>`);
        }
    }
}

// ===== ТАЙМЕР =====
function startTimer() {
    stopTimer();
    timerSeconds = 0;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        timerSeconds++;
        updateTimerDisplay();
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimerDisplay() {
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;
    const display = document.getElementById('recording-timer');
    if (display) display.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ===== ЗБЕРЕЖЕННЯ / СКАСУВАННЯ =====
async function cancelRecording() {
    await stopAudioRecording();
    audioChunks = [];
    timerSeconds = 0;
    showScreen('dashboard-screen');
}

async function saveRecording() {
    const saveBtn = document.querySelector('[data-testid="save-recording-btn"]');
    const cancelBtn = document.querySelector('[data-testid="cancel-recording-btn"]');
    const originalText = saveBtn ? saveBtn.textContent : "Зберегти";

    // Чекаємо завершення MediaRecorder, щоб останній шматок аудіо гарантовано потрапив у audioChunks
    await stopAudioRecording();

    if (audioChunks.length === 0) {
        showNotification("Запис порожній! Спробуйте записати хоча б пару секунд.", "error");
        return;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Аналізуємо голос...";
    }
    if (cancelBtn) cancelBtn.disabled = true;

    showNotification("Завантажуємо аудіо та запускаємо AI-аналіз...", "success");

    const mimeType = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : 'audio/webm';
    const audioBlob = new Blob(audioChunks, { type: mimeType });

    const formData = new FormData();
    formData.append("file", audioBlob, "record.webm");

    const savedEmail = localStorage.getItem('userEmail') || "testuser@kpi.ua";
    formData.append("email", savedEmail);

    try {
        const response = await fetch(`${API_BASE_URL}/api/audio/upload`, {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (response.ok && data.status === "success") {
            showNotification(data.message || "Готово!", "success");
            audioChunks = [];
            await loadUserHistory();
            if (userHistoryRecords.length > 0) {
                openAnalytics(0);
            } else if (data.record) {
                openAnalytics(data.record);
            }
        } else {
            showNotification("Помилка: " + (data.message || "Невідома помилка"), "error");
        }
    } catch (error) {
        console.error("Помилка відправки:", error);
        showNotification("Сервер не відповідає. Перевірте, чи запущені Spring Boot (:8080) та ML-сервіс (:8000).", "error");
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
        }
        if (cancelBtn) cancelBtn.disabled = false;
    }
}

// ===== КАСТОМНЕ ВІКНО ПІДТВЕРДЖЕННЯ =====
function showCustomConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-confirm-overlay');
        const msgEl = document.getElementById('confirm-message');
        const btnYes = document.getElementById('confirm-yes-btn');
        const btnCancel = document.getElementById('confirm-cancel-btn');

        msgEl.textContent = message;
        overlay.classList.add('show');

        const cleanup = () => {
            overlay.classList.remove('show');
            btnYes.onclick = null;
            btnCancel.onclick = null;
        };

        btnYes.onclick = () => { cleanup(); resolve(true); };
        btnCancel.onclick = () => { cleanup(); resolve(false); };
    });
}

// ===== ВИДАЛЕННЯ ЗАПИСУ =====
async function deleteRecord(recordId) {
    const isConfirmed = await showCustomConfirm("Ви впевнені, що хочете назавжди видалити цей запис?");
    if (!isConfirmed) return;

    showNotification("Видалення...", "success");

    try {
        const response = await fetch(`${API_BASE_URL}/api/audio/delete/${recordId}`, {
            method: "DELETE"
        });

        const data = await response.json();

        if (response.ok && data.status === "success") {
            showNotification(data.message, "success");
            showScreen('dashboard-screen');
        } else {
            showNotification("Помилка: " + data.message, "error");
        }
    } catch (error) {
        console.error("Помилка видалення:", error);
        showNotification("Сервер не відповідає.", "error");
    }
}

// ===== ВКЛАДКИ ПІДТРИМКИ =====
function switchSupportTab(tab) {
    const tabs = document.querySelectorAll('#support-tabs .tab');
    const findContent = document.getElementById('find-support-content');
    const chatsContent = document.getElementById('my-chats-content');

    tabs.forEach(t => t.classList.remove('active'));

    if (tab === 'find') {
        tabs[0].classList.add('active');
        findContent.style.display = 'block';
        chatsContent.style.display = 'none';
    } else {
        tabs[1].classList.add('active');
        findContent.style.display = 'none';
        chatsContent.style.display = 'block';
    }
}

function startAnonymousSearch() {
    document.getElementById('search-card').style.display = 'none';
    document.getElementById('search-results-area').style.display = 'block';
}

function stopAnonymousSearch() {
    document.getElementById('search-results-area').style.display = 'none';
    document.getElementById('search-card').style.display = 'block';
}

// ===== ІНІЦІАЛІЗАЦІЯ =====
document.addEventListener('DOMContentLoaded', () => {
    const waveBars = document.querySelectorAll('.wave-bar');
    waveBars.forEach((bar, index) => {
        const delay = (index * 0.05) + (Math.random() * 0.1);
        const duration = 0.6 + (Math.random() * 0.4);
        bar.style.animationDelay = `${delay}s`;
        bar.style.animationDuration = `${duration}s`;
    });
});