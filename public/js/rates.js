/* Credit rates shown in the UI — loaded from the server so pricing changes in .env apply everywhere.
   Elements with data-rate="standard|diarization|hour-standard|hour-diarization|regenerate|joining|friend|referrer|trial" are filled in automatically. */
window.AIX_RATES = { standard_per_min: 1, diarization_per_min: 2, regenerate_per_min: 0.5, max_audio_hours: 10, usd_inr: 96,
  joining_bonus: 86, friend_bonus: 30, referrer_reward: 86, free_trial_credits: 60 };
// Rupees per US dollar for cost figures (admin pages) — the server value replaces the default once loaded
window.AIX_FX = function () { return (window.AIX_RATES && window.AIX_RATES.usd_inr) || 96; };
(function () {
  function apply() {
    var r = window.AIX_RATES;
    var values = {
      'standard': r.standard_per_min,
      'diarization': r.diarization_per_min,
      'hour-standard': r.standard_per_min * 60,
      'hour-diarization': r.diarization_per_min * 60,
      'max-hours': r.max_audio_hours || 10,
      'regenerate': r.regenerate_per_min,
      'joining': r.joining_bonus,
      'friend': r.friend_bonus,
      'referrer': r.referrer_reward,
      'trial': r.free_trial_credits
    };
    document.querySelectorAll('[data-rate]').forEach(function (el) {
      var v = values[el.getAttribute('data-rate')];
      if (v != null) el.textContent = Number(v).toLocaleString('en-IN');
    });
    document.querySelectorAll('[data-fx]').forEach(function (el) {
      el.textContent = '₹' + Number(window.AIX_FX()).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    });
  }
  fetch('/api/config/rates', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (d) {
      if (d && d.standard_per_min && d.diarization_per_min) window.AIX_RATES = d;
      apply();
      document.dispatchEvent(new Event('aix-rates'));
    })
    .catch(apply);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
