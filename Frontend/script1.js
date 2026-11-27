let mediaRecorder = null;
let audioChunks = [];
let recordingStopPromise = null;
let timerInterval = null;
let timerSeconds = 0;

// Автовизначення: локально стукаємо в Spring Boot на :8080, на продакшені — в Render
// На локальному http.server (:5500) стукаємо в :8080, а через Docker Nginx (:3000) чи тунель — відносний /api/
const API_BASE_URL = (window.location.port === "5500" || window.location.protocol === "file:")
    ? "http://localhost:8080"
    : "";

let userHistoryRecords = [];

let isDemoMode = false;

function startDemoMode() {
    isDemoMode = true;
    showScreen('recording-screen');
}

// ===== JWT-АВТОРИЗАЦІЯ =====
function getAuthToken() {
    return localStorage.getItem('authToken');
}

function getAuthHeaders(extra = {}) {
    const token = getAuthToken();
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

function clearAuthSession() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userRole');
    localStorage.removeItem('refreshToken');
    userHistoryRecords = [];
}

async function refreshAuthToken() {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return false;

    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken })
        });
        if (!response.ok) return false;

        const data = await response.json();
        if (data.token) {
            localStorage.setItem('authToken', data.token);
            if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
            if (data.role) localStorage.setItem('userRole', data.role);
            return true;
        }
    } catch (err) {
        console.error("Помилка оновлення JWT:", err);
    }
    return false;
}

function handleUnauthorized(response) {
    if (response.status === 401 || response.status === 403) {
        clearAuthSession();
        showNotification("Сесія завершилась або немає доступу. Увійдіть знову.", "error");
        showScreen('login-screen');
        return true;
    }
    return false;
}

function logout() {
    clearAuthSession();
    showNotification("Ви вийшли з акаунту", "success");
    showScreen('landing-screen');
}

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
    if (['landing-screen', 'login-screen', 'register-screen'].includes(screenId)) {
        isDemoMode = false;
    }

    if (screenId === 'dashboard-screen' && isDemoMode && !getAuthToken()) {
        isDemoMode = false;
        screenId = 'landing-screen';
    }

    const protectedScreens = ['dashboard-screen', 'recording-screen', 'analytics-screen', 'support-screen', 'profile-screen', 'admin-screen'];
    const allowedInDemo = ['recording-screen', 'analytics-screen'];
    if (protectedScreens.includes(screenId) && !getAuthToken() && !(isDemoMode && allowedInDemo.includes(screenId))) {
        screenId = 'login-screen';
    }

    if (screenId === 'admin-screen' && localStorage.getItem('userRole') !== 'ADMIN') {
        showNotification("Доступ лише для адміністратора.", "error");
        screenId = 'dashboard-screen';
    }

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
        updateRoleUI();
        loadUserHistory();
    } else if (screenId === 'profile-screen') {
        loadProfile();
    } else if (screenId === 'admin-screen') {
        loadAdminPanel();
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

        const data = await response.json().catch(() => ({}));

        if (response.ok && data.token) {
            localStorage.setItem('authToken', data.token);
            if (data.refreshToken) {
                localStorage.setItem('refreshToken', data.refreshToken);
            }
            localStorage.setItem('userEmail', data.email || emailValue);
            localStorage.setItem('userRole', data.role || 'USER');
            showNotification("Вхід успішний!", "success");
            showScreen('dashboard-screen');
            document.getElementById('login-email').value = '';
            document.getElementById('login-password').value = '';
        } else {
            showNotification(data.message || "Неправильний email або пароль.", "error");
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

    const consentBox = document.getElementById('register-consent');
    if (consentBox && !consentBox.checked) {
        showNotification("Потрібно надати згоду на обробку даних.", "error");
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

        if (response.ok && data.status === "success" && data.token) {
            localStorage.setItem('authToken', data.token);
            if (data.refreshToken) {
                localStorage.setItem('refreshToken', data.refreshToken);
            }
            localStorage.setItem('userEmail', data.email || emailValue);
            localStorage.setItem('userRole', data.role || 'USER');
            showNotification("Реєстрація успішна!", "success");
            showScreen('dashboard-screen');
            document.getElementById('register-email').value = '';
            document.getElementById('register-password').value = '';
        } else {
            showNotification(data.message || "Помилка реєстрації.", "error");
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
const MAX_RECORDING_SECONDS = 300; // 5 хвилин

async function startAudioRecording() {
    if (!localStorage.getItem('recordingConsentAccepted')) {
        const agreed = await showCustomConfirm(
            "Ваш голос буде зашифровано (AES-256) та передано на AI-аналіз. Результати не є медичним діагнозом. Продовжити?",
            "Згода на запис аудіо",
            "Погоджуюсь"
        );
        if (!agreed) {
            showScreen('dashboard-screen');
            return;
        }
        localStorage.setItem('recordingConsentAccepted', 'true');
    }

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
        startTimer(true);
        updateStopButtonUI(true);
        updatePauseButtonUI(false);
    } catch (err) {
        showNotification("Помилка доступу до мікрофона: " + err.message, "error");
        showScreen('dashboard-screen');
    }
}

async function stopAudioRecording() {
    stopTimer();
    updatePauseButtonUI(false);
    updateStopButtonUI(false);

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        const tracks = mediaRecorder.stream ? mediaRecorder.stream.getTracks() : [];
        mediaRecorder.stop();
        if (recordingStopPromise) {
            await recordingStopPromise;
        }
        tracks.forEach(track => track.stop());
    }
    mediaRecorder = null;
}

function togglePauseRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        startAudioRecording();
        return;
    }

    if (mediaRecorder.state === "recording") {
        mediaRecorder.pause();
        stopTimer();
        updatePauseButtonUI(true);
    } else if (mediaRecorder.state === "paused") {
        mediaRecorder.resume();
        startTimer(false);
        updatePauseButtonUI(false);
    }
}

function updatePauseButtonUI(isPaused) {
    const icon = document.getElementById('pause-btn-icon');
    const waveform = document.getElementById('waveform');
    const hint = document.querySelector('.stop-hint');

    if (waveform) waveform.classList.toggle('paused', isPaused);
    if (icon) {
        icon.innerHTML = isPaused
            ? '<path d="M8 5v14l11-7z"/>'
            : '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    }
    if (hint && mediaRecorder && mediaRecorder.state !== "inactive") {
        hint.textContent = isPaused ? "Запис на паузі" : "Натисніть, щоб зупинити";
    }
}

function startTimer(reset = true) {
    stopTimer();
    if (reset) {
        timerSeconds = 0;
        updateTimerDisplay();
    }
    timerInterval = setInterval(() => {
        timerSeconds++;
        updateTimerDisplay();
        if (timerSeconds >= MAX_RECORDING_SECONDS) {
            stopAudioRecording();
            showNotification("Досягнуто ліміт запису (5 хвилин). Запис автоматично зупинено.", "success");
        }
    }, 1000);
}

function toggleRecording() {
    if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
        stopAudioRecording();
    } else {
        startAudioRecording();
    }
}

function updateStopButtonUI(isRecording) {
    const stopBtn = document.querySelector('.stop-button');
    const hint = document.querySelector('.stop-hint');
    const waveform = document.getElementById('waveform');
    const pauseBtn = document.getElementById('pause-recording-btn');
    if (!stopBtn) return;

    if (waveform) waveform.classList.toggle('paused', !isRecording);
    if (pauseBtn) pauseBtn.classList.toggle('hidden', !isRecording);

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
    if (!getAuthToken()) {
        showScreen('login-screen');
        return;
    }

    const historyList = document.querySelector('.history-list');
    if (!historyList) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/audio/history`, {
            headers: getAuthHeaders()
        });
        if (handleUnauthorized(response)) return;
        if (!response.ok) throw new Error('Помилка завантаження історії');

        userHistoryRecords = await response.json();

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

        renderMoodChart(userHistoryRecords);
        renderMoodCalendar(userHistoryRecords);
        applyHistoryFilters();
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

    const dateObj = record.createdAt ? new Date(record.createdAt) : new Date();
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
            artSection.style.background = meta.gradient;
        }
    }
    if (artBadge) {
        const confPct = record.confidence != null ? Math.round(record.confidence * 100) : null;
        artBadge.textContent = confPct != null ? `${meta.label} • ${confPct}%` : meta.label;
    }

    // 3. Аудіоплеєр (лише для збережених записів, не в демо-режимі)
    const oldPlayer = document.getElementById('custom-audio-player');
    if (oldPlayer) oldPlayer.remove();

    if (record.id && !isDemoMode) {
        const encodedToken = encodeURIComponent(getAuthToken() || "");
        const playerHtml = `
            <div id="custom-audio-player" class="sleek-player">
                <audio id="real-audio" src="${API_BASE_URL}/api/audio/play/${record.id}?token=${encodedToken}" preload="metadata" style="display: none;"></audio>

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
    }

    // 4. Кнопка видалення, збереження арту та нижня кнопка дії
    const deleteBtn = document.querySelector('[data-testid="delete-btn"]');
    if (deleteBtn) {
        deleteBtn.style.display = isDemoMode ? 'none' : 'flex';
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

    const newRecordBtn = document.querySelector('[data-testid="new-record-btn"]');
    if (newRecordBtn) {
        if (isDemoMode) {
            newRecordBtn.textContent = "Зареєструватися, щоб зберігати історію";
            newRecordBtn.onclick = () => showScreen('register-screen');
        } else {
            newRecordBtn.textContent = "Створити новий запис";
            newRecordBtn.onclick = () => showScreen('recording-screen');
        }
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

    await stopAudioRecording();

    if (audioChunks.length === 0) {
        showNotification("Запис порожній! Спробуйте записати хоча б пару секунд.", "error");
        return;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Зберігаємо...";
    }
    if (cancelBtn) cancelBtn.disabled = true;

    const mimeType = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : 'audio/webm';
    const audioBlob = new Blob(audioChunks, { type: mimeType });

    const formData = new FormData();
    formData.append("file", audioBlob, "record.webm");

    try {
        const endpoint = isDemoMode ? `${API_BASE_URL}/api/audio/demo` : `${API_BASE_URL}/api/audio/upload`;
        const headers = isDemoMode ? {} : getAuthHeaders();

        if (isDemoMode && saveBtn) {
            saveBtn.textContent = "Аналізуємо голос...";
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: formData
        });

        if (!isDemoMode && handleUnauthorized(response)) return;
        const data = await response.json();

        if (response.ok && data.status === "success") {
            audioChunks = [];
            if (isDemoMode) {
                showNotification("Демо-аналіз готовий! Запис не збережено.", "success");
                if (data.record) openAnalytics(data.record);
            } else {
                showNotification("Аудіо збережено! AI-аналіз триває у фоні...", "success");
                showScreen('dashboard-screen');
                if (data.recordId) {
                    pollRecordStatus(data.recordId);
                }
            }
        } else {
            showNotification("Помилка: " + (data.message || "Невідома помилка"), "error");
        }
    } catch (error) {
        console.error("Помилка відправки:", error);
        showNotification("Сервер не відповідає. Перевірте Spring Boot (:8080).", "error");
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalText;
        }
        if (cancelBtn) cancelBtn.disabled = false;
    }
}

async function pollRecordStatus(recordId, maxAttempts = 30) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
            const response = await fetch(`${API_BASE_URL}/api/audio/status/${recordId}`, {
                headers: getAuthHeaders()
            });
            if (!response.ok) return;

            const data = await response.json();
            if (data.status === "COMPLETED") {
                showNotification("AI-аналіз завершено!", "success");
                await loadUserHistory();
                if (data.record) {
                    openAnalytics(data.record);
                }
                return;
            }
            if (data.status === "FAILED") {
                showNotification("Помилка ML-аналізу. Аудіо збережено — можна повторити пізніше.", "error");
                await loadUserHistory();
                return;
            }
        } catch (err) {
            console.error("Помилка перевірки статусу:", err);
        }
    }
}

async function retryRecordAnalysis(recordId) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/audio/${recordId}/retry`, {
            method: "POST",
            headers: getAuthHeaders()
        });
        if (handleUnauthorized(response)) return;
        const data = await response.json();

        if (response.ok && data.status === "success") {
            showNotification("Повторний аналіз запущено...", "success");
            await loadUserHistory();
            pollRecordStatus(recordId);
        } else {
            showNotification(data.message || "Не вдалося перезапустити аналіз", "error");
        }
    } catch (err) {
        console.error("Помилка retry:", err);
        showNotification("Сервер не відповідає", "error");
    }
}

// ===== КАСТОМНЕ ВІКНО ПІДТВЕРДЖЕННЯ =====
function showCustomConfirm(message, title = "Видалити запис?", confirmLabel = "Видалити") {
    return new Promise((resolve) => {
        const overlay = document.getElementById('custom-confirm-overlay');
        const titleEl = overlay.querySelector('.confirm-title');
        const msgEl = document.getElementById('confirm-message');
        const btnYes = document.getElementById('confirm-yes-btn');
        const btnCancel = document.getElementById('confirm-cancel-btn');

        if (titleEl) titleEl.textContent = title;
        msgEl.textContent = message;
        btnYes.textContent = confirmLabel;
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
            method: "DELETE",
            headers: getAuthHeaders()
        });

        if (handleUnauthorized(response)) return;
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

    if (localStorage.getItem('refreshToken')) {
        refreshAuthToken();
        setInterval(refreshAuthToken, 45 * 60 * 1000);
    }
});

// ===== ФІЛЬТРИ ІСТОРІЇ ТА ГРАФІК CHART.JS =====
let activeMoodFilter = 'all';
let moodChartInstance = null;
let activeChartPeriod = '7d';

function setChartPeriod(period, btnEl) {
    activeChartPeriod = period;
    document.querySelectorAll('#chart-period-chips .filter-chip').forEach(c => c.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderMoodChart(userHistoryRecords);
}

function getRecordMoodKey(record) {
    const normalized = (record.moodType || "").toLowerCase();
    if (normalized.includes("рад") || normalized.includes("joy")) return 'joy';
    if (normalized.includes("стрес") || normalized.includes("трив") || normalized.includes("stress")) return 'stress';
    if (normalized.includes("смут") || normalized.includes("сум") || normalized.includes("sad")) return 'sadness';
    return 'calm';
}

function setMoodFilter(moodKey, btnEl) {
    activeMoodFilter = moodKey;
    document.querySelectorAll('#mood-filter-chips .filter-chip').forEach(c => c.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    applyHistoryFilters();
}

function resetHistoryFilters(event) {
    if (event) event.preventDefault();
    activeMoodFilter = 'all';
    const searchInput = document.getElementById('history-search-input');
    if (searchInput) searchInput.value = '';
    document.querySelectorAll('#mood-filter-chips .filter-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.mood === 'all');
    });
    applyHistoryFilters();
}

function applyHistoryFilters() {
    const historyList = document.querySelector('.history-list');
    if (!historyList) return;

    const searchInput = document.getElementById('history-search-input');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

    const filtered = userHistoryRecords.filter(record => {
        const moodMatch = activeMoodFilter === 'all' || getRecordMoodKey(record) === activeMoodFilter;
        const textMatch = !query || (record.transcription || '').toLowerCase().includes(query);
        return moodMatch && textMatch;
    });

    historyList.innerHTML = '';

    if (userHistoryRecords.length === 0) {
        historyList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">У вас поки немає записів. Створіть перший!</p>';
        return;
    }

    if (filtered.length === 0) {
        historyList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">За обраним фільтром записів не знайдено.</p>';
        return;
    }

    filtered.forEach(record => {
        const origIndex = userHistoryRecords.indexOf(record);
        const dateObj = new Date(record.createdAt);
        const dateStr = dateObj.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
        const timeStr = dateObj.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

        const status = record.status || 'COMPLETED';
        const meta = getMoodMeta(record.moodType, record.crisisDetected);

        let badgeHtml = `<span class="mood-tag ${meta.tagClass}">${escapeHtml(meta.label)}</span>`;
        let previewText = "";
        let clickAction = `openAnalytics(${origIndex})`;
        let retryBtnHtml = "";

        if (status === 'PENDING') {
            badgeHtml = `<span class="mood-tag tag-pending">Аналізується...</span>`;
            previewText = "AI-аналіз триває у фоні. Результат з'явиться автоматично.";
            clickAction = `showNotification('Запис ще обробляється AI, зачекайте кілька секунд.', 'success')`;
        } else if (status === 'FAILED') {
            badgeHtml = `<span class="mood-tag tag-failed">Помилка аналізу</span>`;
            previewText = "ML-сервіс був недоступний, але ваше зашифроване аудіо збережено.";
            clickAction = `showNotification('Натисніть «Повторити аналіз», щоб обробити запис.', 'error')`;
            retryBtnHtml = `<button class="retry-btn" onclick="event.stopPropagation(); retryRecordAnalysis(${record.id})">Повторити аналіз</button>`;
        } else {
            const rawText = (record.transcription || "").trim();
            previewText = rawText.length > 110
                ? escapeHtml(rawText.slice(0, 110)) + "..."
                : escapeHtml(rawText || "Натисніть, щоб відкрити аналітику та прослухати");
        }

        const recordHtml = `
            <div class="history-item" onclick="${clickAction}">
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
                    ${badgeHtml}
                </div>
                <p class="history-preview">${previewText}</p>
                ${retryBtnHtml}
            </div>
        `;
        historyList.insertAdjacentHTML('beforeend', recordHtml);
    });
}

function renderMoodChart(records) {
    const canvas = document.getElementById('mood-dynamics-chart');
    const wrapper = canvas ? canvas.parentElement : null;
    const emptyMsg = document.getElementById('chart-empty-msg');
    if (!canvas || typeof Chart === 'undefined') return;

    const now = Date.now();
    const periodLimitMs = activeChartPeriod === '7d'
        ? 7 * 24 * 60 * 60 * 1000
        : activeChartPeriod === '30d'
            ? 30 * 24 * 60 * 60 * 1000
            : null;

    const scored = records
        .filter(r => r.calmScore != null || r.joyScore != null || r.sadnessScore != null || r.stressScore != null)
        .filter(r => !periodLimitMs || (r.createdAt && (now - new Date(r.createdAt).getTime()) <= periodLimitMs))
        .slice(0, 30)
        .reverse();

    if (moodChartInstance) {
        moodChartInstance.destroy();
        moodChartInstance = null;
    }

    if (scored.length < 2) {
        if (wrapper) wrapper.style.display = 'none';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }

    if (wrapper) wrapper.style.display = 'block';
    if (emptyMsg) emptyMsg.style.display = 'none';

    const labels = scored.map(r => {
        const d = new Date(r.createdAt);
        return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) + ' ' +
            d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    });

    const toPct = (v) => Math.round((v || 0) * 100);

    moodChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Спокій',
                    data: scored.map(r => toPct(r.calmScore)),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.12)',
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3
                },
                {
                    label: 'Радість',
                    data: scored.map(r => toPct(r.joyScore)),
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.12)',
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3
                },
                {
                    label: 'Сум',
                    data: scored.map(r => toPct(r.sadnessScore)),
                    borderColor: '#a855f7',
                    backgroundColor: 'rgba(168, 85, 247, 0.12)',
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3
                },
                {
                    label: 'Стрес',
                    data: scored.map(r => toPct(r.stressScore)),
                    borderColor: '#f97316',
                    backgroundColor: 'rgba(249, 115, 22, 0.12)',
                    tension: 0.35,
                    borderWidth: 2,
                    pointRadius: 3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#9ca3af', boxWidth: 12, padding: 14 }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#9ca3af', maxRotation: 0, autoSkip: true, maxTicksLimit: 5 },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                y: {
                    min: 0,
                    max: 100,
                    ticks: { color: '#9ca3af', callback: (v) => v + '%' },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                }
            }
        }
    });
}

// ===== РОЛІ ТА ПРОФІЛЬ =====
function updateRoleUI() {
    const isAdmin = localStorage.getItem('userRole') === 'ADMIN';
    const adminNavBtn = document.getElementById('admin-nav-btn');
    const profileAdminBtn = document.getElementById('profile-admin-btn');
    if (adminNavBtn) adminNavBtn.style.display = isAdmin ? 'inline-flex' : 'none';
    if (profileAdminBtn) profileAdminBtn.style.display = isAdmin ? 'block' : 'none';
}

async function loadProfile() {
    updateRoleUI();
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
            headers: getAuthHeaders()
        });
        if (handleUnauthorized(response)) return;
        if (!response.ok) return;

        const data = await response.json();
        const emailEl = document.getElementById('profile-email');
        const roleEl = document.getElementById('profile-role');
        const countEl = document.getElementById('profile-records-count');

        if (emailEl) emailEl.textContent = data.email || localStorage.getItem('userEmail') || '—';
        if (roleEl) {
            roleEl.textContent = data.role || 'USER';
            roleEl.classList.toggle('admin', data.role === 'ADMIN');
        }
        if (countEl) countEl.textContent = data.recordsCount ?? 0;
    } catch (error) {
        console.error("Помилка завантаження профілю:", error);
    }
}

async function deleteOwnAccount() {
    const confirmed = await showCustomConfirm(
        "Усі ваші зашифровані записи (.enc) та акаунт будуть назавжди видалені. Продовжити?",
        "Видалити акаунт?",
        "Видалити назавжди"
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/account`, {
            method: "DELETE",
            headers: getAuthHeaders()
        });
        if (handleUnauthorized(response)) return;
        const data = await response.json();

        if (response.ok && data.status === "success") {
            clearAuthSession();
            showNotification(data.message || "Акаунт видалено", "success");
            showScreen('landing-screen');
        } else {
            showNotification(data.message || "Не вдалося видалити акаунт", "error");
        }
    } catch (error) {
        console.error(error);
        showNotification("Помилка з'єднання з сервером", "error");
    }
}

// ===== АДМІН-ПАНЕЛЬ =====
async function loadAdminPanel() {
    try {
        const [metricsRes, usersRes] = await Promise.all([
            fetch(`${API_BASE_URL}/api/admin/metrics`, { headers: getAuthHeaders() }),
            fetch(`${API_BASE_URL}/api/admin/users`, { headers: getAuthHeaders() })
        ]);

        if (handleUnauthorized(metricsRes) || handleUnauthorized(usersRes)) return;

        const metrics = await metricsRes.json();
        const users = await usersRes.json();

        document.getElementById('admin-total-users').textContent = metrics.totalUsers ?? 0;
        document.getElementById('admin-blocked-users').textContent = metrics.blockedUsers ?? 0;
        document.getElementById('admin-total-records').textContent = metrics.totalRecords ?? 0;
        document.getElementById('admin-crisis-records').textContent = metrics.crisisRecords ?? 0;

        renderAdminAvgEmotions(metrics.averageEmotions || {});
        renderAdminUsersList(users);
    } catch (error) {
        console.error("Помилка завантаження адмінки:", error);
        showNotification("Не вдалося завантажити дані адмін-панелі", "error");
    }
}

function renderAdminAvgEmotions(avg) {
    const container = document.getElementById('admin-avg-emotions');
    if (!container) return;

    const items = [
        { key: 'calm', label: 'Спокій', color: 'var(--color-calm)' },
        { key: 'joy', label: 'Радість', color: 'var(--color-joy)' },
        { key: 'sadness', label: 'Сум', color: 'var(--color-harmony)' },
        { key: 'stress', label: 'Стрес / Тривога', color: 'var(--color-stress)' }
    ];

    if (Object.keys(avg).length === 0) {
        container.innerHTML = '<p class="chart-empty-msg">Поки немає проаналізованих записів.</p>';
        return;
    }

    container.innerHTML = items.map(item => {
        const pct = Math.round((avg[item.key] || 0) * 100);
        return `
            <div class="progress-item">
                <div class="progress-header">
                    <span class="progress-label">${item.label}</span>
                    <span class="progress-value">${pct}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${pct}%; background: ${item.color};"></div>
                </div>
            </div>
        `;
    }).join('');
}

function renderAdminUsersList(users) {
    const container = document.getElementById('admin-users-list');
    if (!container) return;

    const currentEmail = (localStorage.getItem('userEmail') || '').toLowerCase();

    container.innerHTML = users.map(u => {
        const isSelf = (u.email || '').toLowerCase() === currentEmail;
        const isAdmin = u.role === 'ADMIN';
        const btnHtml = isSelf
            ? '<span class="admin-user-meta">Поточний акаунт</span>'
            : `<button class="admin-block-btn ${u.blocked ? 'unblock' : 'block'}" onclick="toggleBlockUser(${u.id}, ${!u.blocked}, '${escapeHtml(u.email)}')">
                    ${u.blocked ? 'Розблокувати' : 'Заблокувати'}
               </button>`;

        return `
            <div class="admin-user-card">
                <div class="admin-user-info">
                    <div class="admin-user-email">
                        <span>${escapeHtml(u.email)}</span>
                        <span class="role-badge ${isAdmin ? 'admin' : ''}">${escapeHtml(u.role)}</span>
                        ${u.blocked ? '<span class="status-badge-blocked">Заблокований</span>' : ''}
                    </div>
                    <div class="admin-user-meta">Записів: ${u.recordsCount ?? 0}</div>
                </div>
                ${btnHtml}
            </div>
        `;
    }).join('');
}

async function toggleBlockUser(userId, nextBlocked, email) {
    const actionLabel = nextBlocked ? "Заблокувати" : "Розблокувати";
    const confirmed = await showCustomConfirm(
        `${actionLabel} користувача ${email}?`,
        `${actionLabel} акаунт?`,
        actionLabel
    );
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/admin/users/${userId}/block`, {
            method: "PATCH",
            headers: getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ blocked: nextBlocked })
        });
        if (handleUnauthorized(response)) return;
        const data = await response.json();

        if (response.ok && data.status === "success") {
            showNotification(data.message, "success");
            loadAdminPanel();
        } else {
            showNotification(data.message || "Помилка зміни статусу", "error");
        }
    } catch (error) {
        console.error(error);
        showNotification("Сервер не відповідає", "error");
    }
}

// ===== КАЛЕНДАР НАСТРОЮ =====
let calendarViewDate = new Date();

function changeCalendarMonth(delta) {
    calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + delta, 1);
    renderMoodCalendar(userHistoryRecords);
}

function renderMoodCalendar(records) {
    const grid = document.getElementById('mood-calendar-grid');
    const label = document.getElementById('calendar-month-label');
    if (!grid || !label) return;

    const year = calendarViewDate.getFullYear();
    const month = calendarViewDate.getMonth();

    label.textContent = calendarViewDate.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });

    // Групуємо всі завершені записи за датою YYYY-MM-DD
    const dayMap = {};
    (records || []).forEach(r => {
        if (!r.createdAt || (r.status && r.status !== 'COMPLETED')) return;
        const d = new Date(r.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!dayMap[key]) dayMap[key] = [];
        dayMap[key].push(r);
    });

    const moodLabels = {
        calm: 'Спокій',
        joy: 'Радість',
        sadness: 'Сум',
        stress: 'Стрес / Тривога',
        crisis: 'Потрібна підтримка'
    };

    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // Пн = 0 ... Нд = 6
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    let html = '';
    for (let i = 0; i < startOffset; i++) {
        html += '<div class="calendar-day empty"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dayRecords = dayMap[key];
        const isToday = key === todayKey ? ' today' : '';

        if (dayRecords && dayRecords.length > 0) {
            const hasCrisis = dayRecords.some(r => r.crisisDetected);
            let moodKey = 'calm';

            if (hasCrisis) {
                moodKey = 'crisis';
            } else {
                const totals = { calm: 0, joy: 0, sadness: 0, stress: 0 };
                dayRecords.forEach(r => {
                    totals.calm += Number(r.calmScore || 0);
                    totals.joy += Number(r.joyScore || 0);
                    totals.sadness += Number(r.sadnessScore || 0);
                    totals.stress += Number(r.stressScore || 0);
                });
                moodKey = Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0];
            }

            const latestRecord = dayRecords[0];
            const origIndex = userHistoryRecords.indexOf(latestRecord);
            const title = `${moodLabels[moodKey]} (записів: ${dayRecords.length}) — натисніть, щоб відкрити`;
            html += `<div class="calendar-day has-record mood-${moodKey}${isToday}" onclick="openAnalytics(${origIndex})" title="${escapeHtml(title)}">${day}</div>`;
        } else {
            html += `<div class="calendar-day${isToday}">${day}</div>`;
        }
    }

    grid.innerHTML = html;
}