/* MOC → branded A4 PDF file (jsPDF). Used by the New MOC, Records and shared-link pages.
   AIX_MOC_PDF(mom, { refId, advisory, letterhead, fallback }) — returns false (and calls fallback)
   when the text has characters the built-in PDF font cannot draw, e.g. Hindi script. */
(function () {
  var JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    return new Promise(function (ok, fail) {
      var s = document.createElement('script'); s.src = JSPDF_URL;
      s.onload = function () { ok(window.jspdf.jsPDF); }; s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  function loadLogo() {
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          ok({ data: c.toDataURL('image/png'), ratio: img.naturalWidth / img.naturalHeight });
        } catch (e) { ok(null); }
      };
      img.onerror = function () { ok(null); };
      img.src = '/aix-logo.png';
    });
  }
  function list(v) {
    if (!v) return [];
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return []; } }
    return Array.isArray(v) ? v : [];
  }
  function clean(s) {
    return String(s == null ? '' : s).replace(/₹\s?/g, 'Rs. ').replace(/[✓✔]/g, '-')
      .replace(/[​-‍﻿]/g, '').replace(/ /g, ' ');
  }
  var UNSUPPORTED = /[^\u0000-ÿ–—‘’“”•…€]/;

  window.AIX_MOC_PDF = async function (m, opt) {
    opt = opt || {};
    var LH = opt.letterhead || {};
    var att = list(m.attendees), ag = list(m.agenda), dp = list(m.discussion_points), dec = list(m.decisions),
        ai = list(m.action_items), xsum = list(m.executive_summary), trk = list(m.pending_tracker), agd = list(m.next_agenda);
    var ADV = !!opt.advisory || xsum.length > 0 || trk.length > 0;
    var probe = [m.meeting_title, m.summary, m.next_meeting, m.client_name, m.subject, LH.firm_name, LH.firm_service_line,
      JSON.stringify([att, ag, dp, dec, ai, xsum, trk, agd])].map(clean).join(' ');
    if (UNSUPPORTED.test(probe)) { if (opt.fallback) opt.fallback(); return false; }

    var J, logo;
    try { J = await loadJsPDF(); } catch (e) { if (opt.fallback) opt.fallback(); return false; }
    logo = await loadLogo();

    var refId = opt.refId || 'MOC';
    var doc = new J({ unit: 'pt', format: 'a4' });
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    var M = 44, CW = W - 2 * M, TOP = 56, BOTTOM = H - 56;
    var NAVY = [15, 27, 61], GOLD = [184, 145, 42], INK = [24, 28, 40], INK2 = [80, 88, 108], MUTED = [138, 147, 168],
        LINE = [228, 223, 210], TINT = [249, 247, 241], HEAD = [243, 239, 229], GREEN = [46, 125, 82];
    var y = 0;
    function rgb(c, fn) { doc[fn](c[0], c[1], c[2]); }
    function font(style, size, c) { doc.setFont('helvetica', style); doc.setFontSize(size); if (c) rgb(c, 'setTextColor'); }
    function newPage() { doc.addPage(); y = TOP; }
    function ensure(h) { if (y + h > BOTTOM) newPage(); }
    function para(text, size, c, indent, style, gap) {
      size = size || 10.5; indent = indent || 0;
      font(style || 'normal', size, c || INK);
      var lh = size * 1.5, lines = doc.splitTextToSize(clean(text), CW - indent);
      lines.forEach(function (l) { ensure(lh); doc.text(l, M + indent, y + size); y += lh; });
      y += (gap == null ? 4 : gap);
    }
    function section(text) {
      ensure(56); y += 14;
      rgb(GOLD, 'setFillColor'); doc.rect(M, y + 1, 3, 11, 'F');
      font('bold', 9, NAVY); doc.text(clean(text).toUpperCase(), M + 10, y + 10, { charSpace: 0.8 });
      y += 18; rgb(LINE, 'setDrawColor'); doc.setLineWidth(0.7); doc.line(M, y, W - M, y); y += 10;
    }
    function bullets(items, numberedList) {
      items.forEach(function (t, i) {
        ensure(16);
        if (numberedList) { font('bold', 9.5, GOLD); doc.text(String(i + 1).padStart(2, '0'), M, y + 10.5); }
        else { rgb(GOLD, 'setFillColor'); doc.circle(M + 4, y + 7, 2, 'F'); }
        para(t, 10.5, INK, 22, 'normal', 3);
      });
    }
    // Wrapped-cell table; the header row repeats after a page break
    function table(head, rows, widths) {
      var pad = 6, size = 9.5, lh = size * 1.4, cols = widths.map(function (w) { return w * CW; });
      function row(cells, isHead, shade) {
        font(isHead ? 'bold' : 'normal', isHead ? 7.8 : size);
        var wrapped = cells.map(function (c, i) {
          return doc.splitTextToSize(clean(isHead ? String(c).toUpperCase() : (c == null || c === '' ? '—' : c)), cols[i] - 2 * pad);
        });
        var h = Math.max.apply(null, wrapped.map(function (w) { return w.length; })) * lh + 2 * pad;
        if (y + h > BOTTOM) { newPage(); if (!isHead) row(head, true); }
        font(isHead ? 'bold' : 'normal', isHead ? 7.8 : size);
        var x = M;
        wrapped.forEach(function (w, i) {
          rgb(isHead ? HEAD : (shade ? TINT : [255, 255, 255]), 'setFillColor'); rgb(LINE, 'setDrawColor'); doc.setLineWidth(0.6);
          doc.rect(x, y, cols[i], h, 'FD');
          rgb(isHead ? INK2 : INK, 'setTextColor');
          w.forEach(function (l, k) { doc.text(l, x + pad, y + pad + size - 1 + k * lh); });
          x += cols[i];
        });
        y += h;
      }
      ensure(64); row(head, true);
      rows.forEach(function (r, i) { row(r, false, i % 2 === 1); });
      y += 8;
    }
    // Key facts box: label / value pairs in two columns
    function facts(pairs) {
      pairs = pairs.filter(function (p) { return p[1]; });
      if (!pairs.length) return;
      var colW = CW / 2, rowsN = Math.ceil(pairs.length / 2), boxH = rowsN * 34 + 12;
      ensure(boxH);
      rgb(TINT, 'setFillColor'); rgb(LINE, 'setDrawColor'); doc.roundedRect(M, y, CW, boxH, 6, 6, 'FD');
      pairs.forEach(function (p, i) {
        var cx = M + 14 + (i % 2) * colW, cy = y + 12 + Math.floor(i / 2) * 34;
        font('bold', 7.5, MUTED); doc.text(clean(p[0]).toUpperCase(), cx, cy + 8, { charSpace: 0.6 });
        font('normal', 10, INK); doc.text(doc.splitTextToSize(clean(p[1]), colW - 24)[0], cx, cy + 22);
      });
      y += boxH + 6;
    }

    // ── Header band ──
    var bandH = 124;
    rgb(NAVY, 'setFillColor'); doc.rect(0, 0, W, bandH, 'F');
    rgb(GOLD, 'setFillColor'); doc.rect(0, bandH, W, 3, 'F');
    var brandX = M;
    if (logo) { var lh0 = 26; doc.addImage(logo.data, 'PNG', M, 22, lh0 * logo.ratio, lh0); brandX = M + lh0 * logo.ratio + 10; }
    font('bold', 11, [255, 255, 255]); doc.text('AiX Track', brandX, 34);
    font('normal', 8, [170, 178, 200]); doc.text('Minutes of Conversation', brandX, 45);
    font('bold', 8.5, GOLD); doc.text(refId, W - M, 34, { align: 'right', charSpace: 0.6 });
    if (ADV && LH.firm_name) { font('normal', 8, [190, 196, 214]); doc.text(clean(LH.firm_name), W - M, 46, { align: 'right' }); }
    font('normal', 20, [255, 255, 255]);
    var tl = doc.splitTextToSize(clean(m.meeting_title || 'Conversation'), CW).slice(0, 2);
    doc.text(tl, M, 78);
    font('normal', 9.5, [190, 196, 214]);
    doc.text(clean([m.meeting_date, m.meeting_time, m.location].filter(Boolean).join('   ·   ')), M, 78 + tl.length * 22);
    y = bandH + 24;

    // ── Letterhead + key facts ──
    if (ADV && (LH.firm_name || LH.firm_service_line)) {
      if (LH.firm_name) para(LH.firm_name, 13, NAVY, 0, 'bold', 0);
      if (LH.firm_service_line) para(LH.firm_service_line, 9.5, GOLD, 0, 'normal', 8);
    }
    var dur = Number(m.duration_seconds) || 0;
    facts(ADV ? [
      ['Client', m.client_name || 'Not recorded'], ['Subject', m.subject || m.meeting_title],
      ['Date', [m.meeting_date, m.meeting_time].filter(Boolean).join(' · ') || 'Not recorded'],
      ['Prepared by', LH.prepared_by || LH.firm_name]
    ] : [
      ['Date', [m.meeting_date, m.meeting_time].filter(Boolean).join(' · ')],
      ['Participants', att.length ? att.length + (att.length === 1 ? ' person' : ' people') : ''],
      ['Duration', dur ? Math.round(dur / 60) + ' min' : ''],
      ['Action items', ai.length ? String(ai.length) : '']
    ]);

    // ── Summary ──
    if (xsum.length) { section('Executive Summary'); xsum.forEach(function (x) { para(x, 10.5, INK, 0, 'normal', 7); }); }
    else if (m.summary) {
      section(ADV ? 'Executive Summary' : 'Summary');
      font('normal', 10.5);
      var sh = doc.splitTextToSize(clean(m.summary), CW - 28).length * 15.75 + 20;
      if (sh < BOTTOM - TOP) { ensure(sh); rgb(TINT, 'setFillColor'); doc.rect(M, y, CW, sh, 'F'); rgb(GOLD, 'setFillColor'); doc.rect(M, y, 3, sh, 'F'); }
      y += 10; para(m.summary, 10.5, INK, 16, 'normal', 14);
    }
    if (att.length) { section('Present (' + att.length + ')'); para(att.join('   ·   '), 10.5, INK2, 0, 'normal', 4); }

    function actionTable(title) {
      if (!ai.length) return;
      section(title);
      table(['#', 'Action / Deliverable', ADV ? 'Responsibility' : 'Owner', ADV ? 'Timeline / Status' : 'Due', 'Priority'],
        ai.map(function (a, i) {
          var when = ADV ? (a.timeline || (a.due_date && a.due_date !== 'TBD' ? a.due_date : 'Not agreed')) + (a.status ? ' · ' + a.status : '')
                         : (a.due_date || 'TBD');
          return [String(i + 1), a.task, a.owner || 'Not assigned', when, a.priority || '—'];
        }), [0.06, 0.5, 0.18, 0.16, 0.1]);
    }
    function discussion(title) {
      if (!dp.length) return;
      section(title);
      dp.forEach(function (d) {
        ensure(34);
        para(d.topic || d, 11, NAVY, 0, 'bold', 2);
        if (d.details) para(d.details, 10, INK2, 0, 'normal', 10);
      });
    }
    function decisions(title) {
      if (!dec.length) return;
      section(title);
      dec.forEach(function (d) {
        ensure(16); rgb(GREEN, 'setDrawColor'); doc.setLineWidth(1.4);
        doc.line(M + 1, y + 7, M + 4, y + 10); doc.line(M + 4, y + 10, M + 9, y + 3);
        para(d, 10.5, INK, 20, 'normal', 4);
      });
    }

    if (ADV) {
      actionTable('1. Action Plan');
      if (trk.length) {
        section('2. Information and Pending Tracker');
        table(['Area', 'Requirement / Deliverable', 'Responsible', 'Status'],
          trk.map(function (r) { return [r.area, r.requirement, r.responsible, r.status]; }), [0.2, 0.44, 0.18, 0.18]);
      }
      discussion('3. Points Discussed');
      decisions('4. Agreed Directions / Working Conclusions');
      if (agd.length) { section('5. Proposed Agenda for Next Meeting'); bullets(agd, true); }
      else if (m.next_meeting) { section('5. Next Meeting'); para(m.next_meeting); }
      var disc = LH.moc_disclaimer || LH.default_disclaimer;
      if (disc) { section('Disclaimer'); para(disc, 9, MUTED, 0, 'italic', 4); }
    } else {
      if (ag.length) { section('Agenda'); bullets(ag, true); }
      discussion('Key Discussions');
      decisions('Decisions');
      actionTable('Action Items');
      if (m.next_meeting) { section('Next Conversation'); para(m.next_meeting); }
    }

    // ── Footer on every page ──
    var pages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= pages; p++) {
      doc.setPage(p);
      rgb(LINE, 'setDrawColor'); doc.setLineWidth(0.6); doc.line(M, H - 38, W - M, H - 38);
      font('normal', 7.8, MUTED);
      doc.text('AiX Track  ·  Draft prepared with AI assistance  ·  Please review before circulation', M, H - 24);
      doc.text(refId + '   ·   Page ' + p + ' of ' + pages, W - M, H - 24, { align: 'right' });
    }
    doc.setProperties({ title: clean(m.meeting_title || 'MOC') + ' · ' + refId, subject: 'Minutes of Conversation', creator: 'AiX Track' });
    var fname = (refId + ' ' + clean(m.meeting_title || 'MOC')).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
    doc.save(fname + '.pdf');
    return true;
  };
})();
