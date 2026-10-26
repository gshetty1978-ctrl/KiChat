// Shared across every page: theme, footer date, token storage, fetch helpers.
const COLORS = ['#3ecfb2', '#7b61ff', '#ff6b9d', '#ff9f43', '#54a0ff', '#5f27cd', '#00d2d3', '#ff6348'];

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
    headers: { 'Content-Type': 'application/json' },
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
