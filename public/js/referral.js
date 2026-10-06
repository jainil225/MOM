/* "Invite friends, earn credits" card — renders into any element with id="referral-card". */
(function () {
  var CSS = '' +
    '.ref-card{background:var(--card,#fff);border:1px solid var(--border,rgba(24,18,12,.09));border-radius:18px;padding:18px 20px;margin:0 0 1.5rem;position:relative;overflow:hidden}' +
    '.ref-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#E0621A,#F5A968)}' +
    '.ref-top{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}' +
    '.ref-title{font-size:17px;font-weight:700;color:var(--ink,#18120C)}' +
    '.ref-title em{font-style:italic;color:var(--gold,#E0621A)}' +
    '.ref-sub{font-size:13px;color:var(--ink2,#4A4238);margin-top:4px;line-height:1.55;max-width:560px}' +
    '.ref-stats{display:flex;gap:8px;flex-wrap:wrap}' +
    '.ref-stat{background:var(--paper2,#E8E4DA);border-radius:12px;padding:8px 12px;text-align:center;min-width:78px}' +
    '.ref-stat b{display:block;font-size:18px;color:var(--ink,#18120C)}' +
    '.ref-stat span{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3,#8A8174)}' +
    '.ref-link{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}' +
    '.ref-link input{flex:1;min-width:220px;padding:9px 12px;border:1px solid var(--border,rgba(24,18,12,.12));border-radius:10px;background:var(--paper,#F0EDE6);color:var(--ink,#18120C);font-family:var(--mono,monospace);font-size:12.5px}' +
    '.ref-btn{padding:9px 14px;border-radius:999px;border:none;font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px}' +
    '.ref-btn.copy{background:var(--navy,#18182C);color:#fff}' +
    '.ref-btn.wa{background:#25D366;color:#fff}';

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  window.renderReferral = function () {
    var el = document.getElementById('referral-card');
    if (!el) return;
    if (!document.getElementById('ref-card-css')) {
      var st = document.createElement('style'); st.id = 'ref-card-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    fetch('/api/referral', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.link) { el.innerHTML = ''; return; }
        var msg = 'I use AiX Track to create Minutes of Conversation (MOC) from my meetings — with who said what. Sign up with my link and get ' +
          d.friend_bonus + ' extra credits: ' + d.link;
        el.innerHTML =
          '<div class="ref-card"><div class="ref-top"><div>' +
          '<div class="ref-title">Invite friends, <em>earn credits</em></div>' +
          '<div class="ref-sub">Your friend gets <b>' + d.friend_bonus + ' extra credits</b> when they sign up with your link. ' +
          'You get <b>' + d.referrer_reward + ' credits</b> as soon as they create their first MOC.</div></div>' +
          '<div class="ref-stats">' +
          '<div class="ref-stat"><b>' + d.invited + '</b><span>Joined</span></div>' +
          '<div class="ref-stat"><b>' + d.rewarded + '</b><span>Rewarded</span></div>' +
          '<div class="ref-stat"><b>' + d.credits_earned + '</b><span>Credits earned</span></div></div></div>' +
          '<div class="ref-link"><input type="text" readonly value="' + esc(d.link) + '" aria-label="Your invite link" onclick="this.select()">' +
          '<button type="button" class="ref-btn copy" id="ref-copy">📋 Copy link</button>' +
          '<a class="ref-btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(msg) + '">WhatsApp</a></div></div>';
        document.getElementById('ref-copy').onclick = function () {
          var btn = this;
          (navigator.clipboard ? navigator.clipboard.writeText(d.link) : Promise.reject()).then(function () {
            btn.textContent = '✓ Copied'; setTimeout(function () { btn.textContent = '📋 Copy link'; }, 2000);
          }).catch(function () { el.querySelector('input').select(); });
        };
      })
      .catch(function () { el.innerHTML = ''; });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.renderReferral);
  else window.renderReferral();
})();
