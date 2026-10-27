// Shared across every page: theme, footer date, token storage, fetch helpers.
const COLORS = ['#3ecfb2', '#7b61ff', '#ff6b9d', '#ff9f43', '#54a0ff', '#5f27cd', '#00d2d3', '#ff6348'];

// ── languages (A to Z by English name) ──────────────────────────────────
// `code` is the i18n/<code>.json file to load. Not every language has a
// translated file yet — missing ones fall back to English automatically,
// so the picker can safely list all of them without anything breaking.
const LANGUAGES = [
  { code: 'af', en: 'Afrikaans', native: 'Afrikaans' },
  { code: 'sq', en: 'Albanian', native: 'Shqip' },
  { code: 'am', en: 'Amharic', native: 'አማርኛ' },
  { code: 'ar', en: 'Arabic', native: 'العربية', rtl: true },
  { code: 'hy', en: 'Armenian', native: 'Հայերեն' },
  { code: 'az', en: 'Azerbaijani', native: 'Azərbaycan' },
  { code: 'eu', en: 'Basque', native: 'Euskara' },
  { code: 'be', en: 'Belarusian', native: 'Беларуская' },
  { code: 'bn', en: 'Bengali', native: 'বাংলা' },
  { code: 'bs', en: 'Bosnian', native: 'Bosanski' },
  { code: 'bg', en: 'Bulgarian', native: 'Български' },
  { code: 'my', en: 'Burmese', native: 'မြန်မာ' },
  { code: 'ca', en: 'Catalan', native: 'Català' },
  { code: 'ceb', en: 'Cebuano', native: 'Cebuano' },
  { code: 'zh-CN', en: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-TW', en: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'co', en: 'Corsican', native: 'Corsu' },
  { code: 'hr', en: 'Croatian', native: 'Hrvatski' },
  { code: 'cs', en: 'Czech', native: 'Čeština' },
  { code: 'da', en: 'Danish', native: 'Dansk' },
  { code: 'nl', en: 'Dutch', native: 'Nederlands' },
  { code: 'en', en: 'English', native: 'English' },
  { code: 'eo', en: 'Esperanto', native: 'Esperanto' },
  { code: 'et', en: 'Estonian', native: 'Eesti' },
  { code: 'fi', en: 'Finnish', native: 'Suomi' },
  { code: 'fr', en: 'French', native: 'Français' },
  { code: 'fy', en: 'Frisian', native: 'Frysk' },
  { code: 'gl', en: 'Galician', native: 'Galego' },
  { code: 'ka', en: 'Georgian', native: 'ქართული' },
  { code: 'de', en: 'German', native: 'Deutsch' },
  { code: 'el', en: 'Greek', native: 'Ελληνικά' },
  { code: 'gu', en: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'ht', en: 'Haitian Creole', native: 'Kreyòl Ayisyen' },
  { code: 'ha', en: 'Hausa', native: 'Hausa' },
  { code: 'haw', en: 'Hawaiian', native: 'ʻŌlelo Hawaiʻi' },
  { code: 'he', en: 'Hebrew', native: 'עברית', rtl: true },
  { code: 'hi', en: 'Hindi', native: 'हिन्दी' },
  { code: 'hmn', en: 'Hmong', native: 'Hmoob' },
  { code: 'hu', en: 'Hungarian', native: 'Magyar' },
  { code: 'is', en: 'Icelandic', native: 'Íslenska' },
  { code: 'ig', en: 'Igbo', native: 'Igbo' },
  { code: 'id', en: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ga', en: 'Irish', native: 'Gaeilge' },
  { code: 'it', en: 'Italian', native: 'Italiano' },
  { code: 'ja', en: 'Japanese', native: '日本語' },
  { code: 'jv', en: 'Javanese', native: 'Basa Jawa' },
  { code: 'kn', en: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'kk', en: 'Kazakh', native: 'Қазақша' },
  { code: 'km', en: 'Khmer', native: 'ខ្មែរ' },
  { code: 'rw', en: 'Kinyarwanda', native: 'Ikinyarwanda' },
  { code: 'ko', en: 'Korean', native: '한국어' },
  { code: 'ku', en: 'Kurdish', native: 'Kurdî' },
  { code: 'ky', en: 'Kyrgyz', native: 'Кыргызча' },
  { code: 'lo', en: 'Lao', native: 'ລາວ' },
  { code: 'la', en: 'Latin', native: 'Latina' },
  { code: 'lv', en: 'Latvian', native: 'Latviešu' },
  { code: 'lt', en: 'Lithuanian', native: 'Lietuvių' },
  { code: 'lb', en: 'Luxembourgish', native: 'Lëtzebuergesch' },
  { code: 'mk', en: 'Macedonian', native: 'Македонски' },
  { code: 'mg', en: 'Malagasy', native: 'Malagasy' },
  { code: 'ms', en: 'Malay', native: 'Bahasa Melayu' },
  { code: 'ml', en: 'Malayalam', native: 'മലയാളം' },
  { code: 'mt', en: 'Maltese', native: 'Malti' },
  { code: 'mi', en: 'Maori', native: 'Māori' },
  { code: 'mr', en: 'Marathi', native: 'मराठी' },
  { code: 'mn', en: 'Mongolian', native: 'Монгол' },
  { code: 'ne', en: 'Nepali', native: 'नेपाली' },
  { code: 'no', en: 'Norwegian', native: 'Norsk' },
  { code: 'ny', en: 'Nyanja (Chichewa)', native: 'Chichewa' },
  { code: 'or', en: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'ps', en: 'Pashto', native: 'پښتو', rtl: true },
  { code: 'fa', en: 'Persian', native: 'فارسی', rtl: true },
  { code: 'pl', en: 'Polish', native: 'Polski' },
  { code: 'pt', en: 'Portuguese', native: 'Português' },
  { code: 'pa', en: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ro', en: 'Romanian', native: 'Română' },
  { code: 'ru', en: 'Russian', native: 'Русский' },
  { code: 'sm', en: 'Samoan', native: 'Gagana Samoa' },
  { code: 'gd', en: 'Scots Gaelic', native: 'Gàidhlig' },
  { code: 'sr', en: 'Serbian', native: 'Српски' },
  { code: 'st', en: 'Sesotho', native: 'Sesotho' },
  { code: 'sn', en: 'Shona', native: 'Shona' },
  { code: 'sd', en: 'Sindhi', native: 'سنڌي', rtl: true },
  { code: 'si', en: 'Sinhala', native: 'සිංහල' },
  { code: 'sk', en: 'Slovak', native: 'Slovenčina' },
  { code: 'sl', en: 'Slovenian', native: 'Slovenščina' },
  { code: 'so', en: 'Somali', native: 'Soomaali' },
  { code: 'es', en: 'Spanish', native: 'Español' },
  { code: 'su', en: 'Sundanese', native: 'Basa Sunda' },
  { code: 'sw', en: 'Swahili', native: 'Kiswahili' },
  { code: 'sv', en: 'Swedish', native: 'Svenska' },
  { code: 'tl', en: 'Tagalog (Filipino)', native: 'Filipino' },
  { code: 'tg', en: 'Tajik', native: 'Тоҷикӣ' },
  { code: 'ta', en: 'Tamil', native: 'தமிழ்' },
  { code: 'tt', en: 'Tatar', native: 'Татар' },
  { code: 'te', en: 'Telugu', native: 'తెలుగు' },
  { code: 'th', en: 'Thai', native: 'ไทย' },
  { code: 'tr', en: 'Turkish', native: 'Türkçe' },
  { code: 'tk', en: 'Turkmen', native: 'Türkmen' },
  { code: 'uk', en: 'Ukrainian', native: 'Українська' },
  { code: 'ur', en: 'Urdu', native: 'اردو', rtl: true },
  { code: 'ug', en: 'Uyghur', native: 'ئۇيغۇرچە', rtl: true },
  { code: 'uz', en: 'Uzbek', native: 'Oʻzbek' },
  { code: 'vi', en: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'cy', en: 'Welsh', native: 'Cymraeg' },
  { code: 'xh', en: 'Xhosa', native: 'isiXhosa' },
  { code: 'yi', en: 'Yiddish', native: 'ייִדיש', rtl: true },
  { code: 'yo', en: 'Yoruba', native: 'Yorùbá' },
  { code: 'zu', en: 'Zulu', native: 'isiZulu' },
];

let currentTranslations = null; // the loaded language's strings
let englishTranslations = null; // fallback for missing keys
let currentLang = 'en';

function t(key, vars) {
  let str = (currentTranslations && currentTranslations[key])
    || (englishTranslations && englishTranslations[key])
    || key;
  if (vars) {
    Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  }
  return str;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
}

async function loadLanguage(code) {
  if (!englishTranslations) {
    englishTranslations = await fetch('/i18n/en.json').then((r) => r.json()).catch(() => ({}));
  }
  if (code === 'en') {
    currentTranslations = englishTranslations;
  } else {
    currentTranslations = await fetch(`/i18n/${code}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  currentLang = code;

  const lang = LANGUAGES.find((l) => l.code === code);
  document.documentElement.setAttribute('lang', code);
  document.documentElement.setAttribute('dir', lang && lang.rtl ? 'rtl' : 'ltr');

  applyTranslations();
  document.querySelectorAll('.js-lang-name').forEach((el) => { el.textContent = lang ? lang.native : 'English'; });
}

async function setLanguage(code) {
  try { localStorage.setItem('kichat-lang', code); } catch (e) {}
  await loadLanguage(code);
  const modal = document.getElementById('language-modal');
  if (modal) modal.hidden = true;
}

function renderLanguageList() {
  const list = document.getElementById('language-list');
  if (!list) return;
  const q = (document.getElementById('language-search').value || '').toLowerCase();
  const filtered = LANGUAGES.filter((l) => l.en.toLowerCase().includes(q) || l.native.toLowerCase().includes(q));
  list.innerHTML = filtered.map((l) => `
    <div class="people-row" onclick="setLanguage('${l.code}')">
      <span class="pname">${l.en}</span>
      <span style="color:var(--fg3);font-size:13px">${l.native}</span>
    </div>
  `).join('');
}

function openLanguageModal() {
  const modal = document.getElementById('language-modal');
  if (!modal) return;
  document.getElementById('language-search').value = '';
  renderLanguageList();
  modal.hidden = false;
}
function closeLanguageModal() {
  const modal = document.getElementById('language-modal');
  if (modal) modal.hidden = true;
}

// Pages that generate content with t() (e.g. chat.js rendering the
// sidebar) should `await languageReady` first, so nothing briefly shows
// raw translation keys before the language file finishes loading.
const languageReady = (async function initLanguage() {
  let saved = 'en';
  try { saved = localStorage.getItem('kichat-lang') || 'en'; } catch (e) {}
  await loadLanguage(saved);
})();

(function restoreTheme() {
  try {
    const saved = localStorage.getItem('kichat-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {}
})();

function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('kichat-theme', next); } catch (e) {}
}

function stampLastModified() {
  const modified = new Date(document.lastModified).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  document.querySelectorAll('.js-last-modified').forEach((el) => { el.textContent = modified; });
}

function getToken() {
  try { return localStorage.getItem('kichat_token'); } catch (e) { return null; }
}
function setToken(t) {
  try { localStorage.setItem('kichat_token', t); } catch (e) {}
}
function clearToken() {
  try { localStorage.removeItem('kichat_token'); } catch (e) {}
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + getToken() } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed');
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function putJSON(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function patchJSON(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function initialsOf(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}
function colorFor(id) {
  return COLORS[id % COLORS.length];
}
function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Redirects to /login.html if there's no token at all. Pages that need the
// user's identity should still call fetchJSON('/api/users/me') themselves
// to confirm the token is actually valid (not just present).
function requireTokenOrRedirect() {
  if (!getToken()) {
    location.href = '/login';
    return false;
  }
  return true;
}

stampLastModified();

// ── installable app (PWA) ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let deferredInstallPrompt = null;

function showInstallButtons() {
  document.querySelectorAll('.js-install-btn').forEach((btn) => { btn.hidden = false; });
}
function hideInstallButtons() {
  document.querySelectorAll('.js-install-btn').forEach((btn) => { btn.hidden = true; });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallButtons();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  hideInstallButtons();
});

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hideInstallButtons();
}
