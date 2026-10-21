/* ═══════════════════════════════════════════════════════════════════
   theme.js — one light/dark theme switch shared by every page
   Load in <head> (before any CSS paints) so there is no light flash.
   Saved choice → localStorage 'mom_theme'; first visit follows the OS.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  var KEY = 'mom_theme';

  function readSaved() {
    try { var v = localStorage.getItem(KEY); return (v === 'dark' || v === 'light') ? v : null; }
    catch (e) { return null; }
  }
  function systemPref() {
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }

  function syncControls(t) {
    var isDark = t === 'dark';
    var btns = document.querySelectorAll('#theme-btn, [data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = isDark ? '☀' : '☾';
      btns[i].title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
      btns[i].setAttribute('aria-label', btns[i].title);
    }
    // terms.html / privacy.html use an icon + label pair
    var icon = document.getElementById('theme-icon');
    var label = document.getElementById('theme-label');
    if (icon) icon.textContent = isDark ? '☀' : '☾';
    if (label) label.textContent = isDark ? 'LIGHT' : 'DARK';
  }

  function applyTheme(t, save) {
    t = t === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    if (save !== false) { try { localStorage.setItem(KEY, t); } catch (e) {} }
    if (document.readyState !== 'loading') syncControls(t);
  }

  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  }

  window.applyTheme = applyTheme;
  window.toggleTheme = toggleTheme;

  // Apply immediately (runs in <head>)
  applyTheme(readSaved() || systemPref(), false);

  document.addEventListener('DOMContentLoaded', function () {
    syncControls(document.documentElement.getAttribute('data-theme'));
  });

  // Keep other open tabs in sync
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) applyTheme(e.newValue, false);
  });
})();

/* Policy re-consent (Screen D): the server answers 428 to signed-in users who have not yet
   accepted the current Terms, Usage Policy and Privacy Policy. Any page that meets it goes
   to /consent and comes back here afterwards. */
(function () {
  if (!window.fetch) return;
  var here = location.pathname;
  if (/^\/(consent|login)/.test(here)) return;
  var origFetch = window.fetch, sent = false;
  window.fetch = function () {
    return origFetch.apply(this, arguments).then(function (res) {
      if (res.status === 428 && !sent) {
        sent = true;
        location.href = '/consent?next=' + encodeURIComponent(here + location.search);
      }
      return res;
    });
  };
})();
