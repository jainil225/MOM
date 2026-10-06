/* Credit rates shown in the UI — loaded from the server so pricing changes in .env apply everywhere.
   Elements with data-rate="standard|diarization|hour-standard|hour-diarization" are filled in automatically. */
window.AIX_RATES = { standard_per_min: 1, diarization_per_min: 2, max_audio_hours: 10 };
(function () {
  function apply() {
    var r = window.AIX_RATES;
    var values = {
      'standard': r.standard_per_min,
      'diarization': r.diarization_per_min,
      'hour-standard': r.standard_per_min * 60,
      'hour-diarization': r.diarization_per_min * 60,
      'max-hours': r.max_audio_hours || 10
    };
    document.querySelectorAll('[data-rate]').forEach(function (el) {
      var v = values[el.getAttribute('data-rate')];
      if (v != null) el.textContent = Number(v).toLocaleString('en-IN');
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
