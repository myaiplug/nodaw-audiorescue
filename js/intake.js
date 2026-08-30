(function () {
const $ = (id) => document.getElementById(id);

const modal = $('order-modal');
const form = $('order-form');
const errorEl = $('form-error');
const submitBtn = $('order-submit');

const NAME_MAX = 200;
const EMAIL_MAX = 254;
const NOTES_MAX = 4000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SERVICE_ALLOWED = ['Rush vocal cleanup', 'Rush full-song rescue'];

const rate = { max: 6, win: 60 * 1000 };
const stamps = [];

function openModal() {
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('name').focus(), 60);
}

function closeModal() {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  errorEl.classList.remove('show');
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.color = '';
  errorEl.classList.add('show');
}

function validate() {
  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const service = $('service').value.trim();
  const notes = $('notes').value.trim();
  if (name.length < 1 || name.length > NAME_MAX) return 'Name is required.';
  if (email.length < 3 || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return 'Enter a valid email so we can send the upload link.';
  }
  if (!SERVICE_ALLOWED.includes(service)) return 'Pick a case type.';
  if (notes.length > NOTES_MAX) return 'Notes are too long.';
  return null;
}

document.querySelectorAll('[data-open-order]').forEach((el) => {
  el.addEventListener('click', openModal);
});
document.querySelector('[data-close-order]').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
});
try {
  if (new URLSearchParams(location.search).get('open') === 'deposit') openModal();
} catch (_) { /* ignore */ }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.remove('show');
  if ($('website').value) return;

  const now = Date.now();
  while (stamps.length && now - stamps[0] > rate.win) stamps.shift();
  if (stamps.length >= rate.max) {
    showError('Too many requests. Try again in a minute.');
    return;
  }

  const err = validate();
  if (err) {
    showError(err);
    return;
  }

  stamps.push(now);
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/checkout/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('name').value.trim(),
        email: $('email').value.trim(),
        service: $('service').value.trim(),
        notes: $('notes').value.trim(),
      }),
    });
    let body = {};
    try {
      body = await res.json();
    } catch (_) { /* ignore */ }
    if (!res.ok || typeof body.url !== 'string' || !/^https:\/\//.test(body.url)) {
      showError(body && body.error ? body.error : 'Checkout failed. Try again in a minute.');
      return;
    }
    location.href = body.url;
  } catch (_) {
    showError('Could not reach checkout. Check your connection and try again.');
  } finally {
    submitBtn.disabled = false;
  }
});
})();
