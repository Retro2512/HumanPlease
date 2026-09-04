/* core.js — everything both views need.
   Exposes window.HP.mountSearch and window.HP.mountRoute so the multi-page
   site and the single-file build run identical code. */

(function () {
  const HP = (window.HP = window.HP || {});

  const $ = (s, r = document) => r.querySelector(s);

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  /* ---------------- formatting ---------------- */

  function mmss(sec) {
    if (sec == null) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m >= 60) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    return m ? m + 'm ' + String(s).padStart(2, '0') + 's' : s + 's';
  }

  function clk(sec) {
    return Math.floor(sec / 60) + ':' + String(Math.round(sec % 60)).padStart(2, '0');
  }

  function human(sec) {
    if (sec == null) return 'unknown';
    if (sec < 60) return sec + ' seconds';
    const m = Math.round(sec / 60);
    if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' + r + ' min' : '');
  }

  const band = (sec) => (sec == null ? 'unk' : sec <= 120 ? 'fast' : sec <= 420 ? 'mid' : 'slow');
  const group = (n) => n.toLocaleString('en-US');

  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const todayIdx = () => (new Date().getDay() + 6) % 7;

  function openNow(hours) {
    if (!hours) return null;
    if (hours.always) return true;
    const d = hours.days[todayIdx()];
    if (!d) return false;
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    return h >= d[0] && h < d[1];
  }

  /* ================= SEARCH ================= */

  const norm = (s) =>
    s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  const compact = (s) => norm(s).replace(/\s/g, '');
  const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const countryName = (code) => {
    if (!code) return '';
    if (code === 'INTL') return 'International';
    try { return regionNames ? regionNames.of(code) || code : code; }
    catch (e) { return code; }
  };
  const flagSrc = (code) => {
    const normalized = String(code || '').toUpperCase();
    if (!/^(?:[A-Z]{2}|INTL)$/.test(normalized)) return '';
    return HP.flagData && HP.flagData[normalized]
      ? HP.flagData[normalized]
      : (HP.assetBase || 'assets/') + 'flags/' + normalized.toLowerCase() + '.svg';
  };

  function httpHref(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      const privateName = !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host);
      const ipLiteral = host.includes(':') || /^\d+(?:\.\d+){0,3}$/.test(host);
      return url.protocol === 'https:' && !url.username && !url.password && !privateName && !ipLiteral ? url.href : '';
    } catch (e) {
      return '';
    }
  }

  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let rowMin = 2;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
        }
        rowMin = Math.min(rowMin, matrix[i][j]);
      }
      if (rowMin > 1) return 2;
    }
    return matrix[a.length][b.length];
  }

  function search(INDEX, raw) {
    const q = norm(raw);
    if (!q) return [];
    const qc = compact(q);
    const out = [];

    for (const c of INDEX) {
      const n = c._n || (c._n = norm(c.n));
      const nc = c._c || (c._c = compact(c.n));
      const country = c.ct ? norm(countryName(c.ct)) : '';
      const haystack = country ? n + ' ' + country + ' ' + c.ct.toLowerCase() : n;
      let score = -1;

      if (n === q) score = 0;
      else if (nc === qc) score = 0.5;
      else if (haystack === q) score = 0.75;
      else if (n.startsWith(q)) score = 1;
      else if (nc.startsWith(qc)) score = 1.5;
      else if (haystack.includes(' ' + q)) score = 2;
      else if (haystack.includes(q)) score = 3;
      else if (q.length >= 4) {
        const parts = q.split(' ');
        if (parts.length > 1 && parts.every((p) => haystack.includes(p))) score = 4;
        else {
          const targets = [nc.slice(0, qc.length), nc, ...n.split(' ').map(compact)];
          if (targets.some((target) => target && editDistance(qc, target) <= 1)) score = 5;
        }
      }

      if (score < 0) continue;
      // a route you can actually follow beats a bare number
      const countryRank = c.ct === 'CA' ? 0 : c.ct === 'US' ? 0.05 : c.ct ? 0.1 : 0.2;
      out.push([score * 10 - Math.min(c.k, 4) - (c.p ? 1 : 0) + Math.min(n.length / 40, 1) + countryRank, c]);
    }

    return out.sort((a, b) => a[0] - b[0]).slice(0, 14).map((x) => x[1]);
  }

  // a route whose hold nobody reported must not read as fast
  function timeCell(c) {
    if (c.t != null) return '<span class="mono t ' + band(c.t) + '">' + mmss(c.t) + '</span>';
    if (c.w) return '<span class="mono t unk">' + mmss(c.w) + ' +hold</span>';
    if (c.d) return '<span class="mono t contacttag">researched</span>';
    if (c.cp || c.cc) return '<span class="mono t unk">contact</span>';
    return '<span class="mono t unk">—</span>';
  }

  function highlight(name, q) {
    const i = norm(name).indexOf(norm(q));
    if (i < 0 || !q) return esc(name);
    return esc(name.slice(0, i)) + '<u>' + esc(name.slice(i, i + q.length)) + '</u>' + esc(name.slice(i + q.length));
  }

  function countUp(el, to, fmt) {
    const t0 = performance.now();
    const paint = (v) => { el.textContent = fmt === 'time' ? mmss(Math.round(v)) : group(Math.round(v)); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return paint(to);
    const frame = (t) => {
      const p = Math.min((t - t0) / 900, 1);
      paint(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /**
   * @param {{index:Array, stats:Object, href:(slug:string)=>string, onPick?:Function}} o
   */
  HP.mountSearch = function (o) {
    const stage = $('#stage');
    const field = $('#field');
    const input = $('#q');
    const tray = $('#results');
    const hits = $('#hits');

    let rows = [];
    let cursor = -1;

    function render(list, q) {
      cursor = -1;
      tray.innerHTML = '';

      if (!list.length) {
        tray.innerHTML =
          '<p class="empty">Nothing matching <b>' + esc(q) + '</b>. ' +
          'Try the parent company or the brand as it appears on your bill.</p>';
        rows = [];
        return;
      }

      tray.innerHTML = list
        .map((c, i) =>
          '<a class="row d' + Math.min(i, 12) + '" role="option" href="' + esc(o.href(c.s)) + '" data-slug="' + esc(c.s) + '">' +
          '<span class="nm">' + highlight(c.n, q) + '</span>' +
          (c.ct ? '<img class="countryflag" src="' + esc(flagSrc(c.ct)) + '" alt="' + esc(countryName(c.ct)) + '" title="' + esc(countryName(c.ct)) + '">' : '') +
          '<span class="dots"></span>' +
          (c.k ? '<span class="mono keys">' + c.k + ' step' + (c.k > 1 ? 's' : '') + '</span>'
            : c.cp ? '<span class="mono keys">' + c.cp + ' phone' + (c.cp > 1 ? 's' : '') + '</span>'
              : c.cc ? '<span class="mono keys">' + c.cc + ' online</span>' : '') +
          timeCell(c) +
          '</a>'
        )
        .join('');

      rows = [...tray.querySelectorAll('.row')];
      if (o.onPick) rows.forEach((r) => r.addEventListener('click', (e) => o.onPick(e, r.dataset.slug)));
    }

    function update() {
      const v = input.value.trim();
      stage.classList.toggle('busy', v.length > 0);
      field.classList.toggle('on', v.length > 0 || document.activeElement === input);

      if (!v) {
        tray.innerHTML = '';
        hits.textContent = '';
        rows = [];
        return;
      }

      const list = search(o.index, v);
      hits.textContent = list.length ? list.length + (list.length === 14 ? '+' : '') : '0';
      render(list, v);
    }

    input.addEventListener('input', update);
    input.addEventListener('focus', () => field.classList.add('on'));
    input.addEventListener('blur', () => { if (!input.value.trim()) field.classList.remove('on'); });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; update(); return; }
      if (!rows.length) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows.forEach((r, i) => r.setAttribute('aria-selected', i === cursor));
        rows[cursor].scrollIntoView({ block: 'nearest' });
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        (rows[cursor] || rows[0]).click();
      }
    });

    // typing anywhere on the page goes into the field
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement === input) return;
      if (/^[a-z0-9]$/i.test(e.key)) input.focus();
    });

    const vals = [o.stats.companies, o.stats.numbers, o.stats.countries];
    [...document.querySelectorAll('.counts .n')].forEach((el, i) => countUp(el, vals[i], el.dataset.fmt));

    HP.resetSearch = () => { input.value = ''; update(); };
    return { update, input };
  };

  /* ================= ROUTE ================= */

  const KINDLAB = { press: 'press', say: 'say', wait: 'wait', enter: 'enter', do: 'then' };
  const VERB = { press: 'Press', say: 'Say', wait: 'Wait', enter: 'Key in', do: 'Then' };
  const DAYNAME = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function fmtHour(h) {
    if (h <= 0 || h >= 24) return 'midnight';
    if (h === 12) return 'noon';
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return (hh % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (hh < 12 ? ' am' : ' pm');
  }

  // whether it is worth dialling right now, and when it will be
  function statusLine(c) {
    const h = c.hours;
    if (!h) return { tone: 'unk', text: 'Opening hours are not published for this line.' };
    if (h.always) return { tone: 'ok', text: 'Answering now. This line runs 24 hours, every day.' };

    const i = todayIdx();
    const now = new Date();
    const t = now.getHours() + now.getMinutes() / 60;
    const today = h.days[i];

    if (today && t >= today[0] && t < today[1]) {
      return { tone: 'ok', text: 'Answering now. Closes at ' + fmtHour(today[1]) + '.' };
    }
    if (today && t < today[0]) {
      return { tone: 'no', text: 'Closed. Opens at ' + fmtHour(today[0]) + ' today.' };
    }
    for (let k = 1; k <= 7; k++) {
      const j = (i + k) % 7;
      if (h.days[j]) {
        return { tone: 'no', text: 'Closed. Opens ' + (k === 1 ? 'tomorrow' : DAYNAME[j]) + ' at ' + fmtHour(h.days[j][0]) + '.' };
      }
    }
    return { tone: 'no', text: 'Closed right now.' };
  }

  function stepFace(s, big) {
    if (s.kind === 'press') return '<span class="cap">' + esc(s.key) + '</span>';
    if (s.kind === 'say') return '<span class="say"><q>' + esc(s.key) + '</q></span>';
    if (s.kind === 'wait') return '<span class="holdband">hold the line</span>';
    if (s.kind === 'enter') return '<span class="slot">' + esc(s.key) + '</span>';
    return '<span class="say ' + (big ? 'bigface' : 'smallface') + '">' +
      esc(s.note || 'follow the prompt') + '</span>';
  }

  // consecutive bare keypresses read as one gesture, not eight rows
  function groupSteps(steps) {
    const out = [];
    for (const s of steps) {
      const prev = out[out.length - 1];
      if (s.kind === 'press' && !s.note && prev && prev.kind === 'press' && !prev.note) {
        prev.keys.push(s.key);
        prev.secs += s.secs;
      } else {
        out.push(s.kind === 'press' ? Object.assign({}, s, { keys: [s.key] }) : Object.assign({}, s));
      }
    }
    return out;
  }

  function renderRoute(c) {
    if (!c.steps.length) return '';

    const groups = groupSteps(c.steps);
    if (c.hold) {
      groups.push({
        kind: 'wait', key: 'hold', secs: c.hold, tail: true,
        note: 'Reported average for this line: ' + human(c.hold) + '.',
      });
    }

    let t = 0;
    const body = groups
      .map((s, i) => {
        const at = clk(t);
        t += s.secs;
        const face =
          s.keys && s.keys.length > 1
            ? s.keys.map((k) => '<span class="cap">' + esc(k) + '</span>').join('<span class="seq"></span>')
            : stepFace(s);
        const label = s.keys && s.keys.length > 1 ? 'Press, in order' : VERB[s.kind];
        const note = s.kind === 'do' ? '' : s.note;
        return (
          '<div class="step d' + Math.min(i, 6) + (s.tail ? ' tail' : '') + '">' +
          '<div class="clk mono">' + at + '</div>' +
          '<div class="body">' +
          '<span class="verb">' + label + '</span>' +
          '<span class="act">' + face + '</span>' +
          (note ? '<span class="note">' + esc(note) + '</span>' : '') +
          '</div></div>'
        );
      })
      .join('');

    const arrival = c.total
      ? '<div class="step end"><div class="clk mono">' + clk(c.total) + '</div>' +
        '<div class="body"><span class="verb arrive">A person answers</span></div></div>'
      : '';

    return body + arrival;
  }

  // only worth a section when the hours actually differ by day —
  // "open 24/7" is one sentence and already sits under the number
  function renderHours(c) {
    const h = c.hours;
    if (!h || h.always) return '';

    const now = new Date();
    const nowHour = now.getHours() + now.getMinutes() / 60;
    const ti = todayIdx();

    const rows = DAYS.map((d, i) => {
      const w = h.days[i];
      return (
        '<div class="hrow' + (i === ti ? ' now' : '') + '">' +
        '<span class="mono d">' + d + '</span>' +
        '<svg class="hbar" viewBox="0 0 24 1" preserveAspectRatio="none" aria-hidden="true">' +
        (w ? '<rect class="window" x="' + Number(w[0]) + '" y="0" width="' + Number(w[1] - w[0]) + '" height="1"></rect>' : '') +
        (i === ti ? '<line class="nowline" x1="' + nowHour + '" y1="0" x2="' + nowHour + '" y2="1"></line>' : '') +
        '</svg></div>'
      );
    }).join('');

    return (
      '<div class="hours">' + rows + '</div>' +
      '<div class="hscale mono"><span></span><div><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>'
    );
  }

  function telHref(value, country) {
    const raw = asciiDigits(value).trim();
    const digits = dialDigits(raw);
    if (!digits) return '';
    if (raw.charAt(0) === '+') return digits.length >= 8 && digits.length <= 15 ? 'tel:+' + digits : '';
    if (country && country !== 'US' && country !== 'CA') {
      return country === 'INTL' || digits.length < 3 ? '' : 'tel:' + digits;
    }
    if (digits.length === 10) return 'tel:+1' + digits;
    if (digits.length === 11 && digits.charAt(0) === '1') return 'tel:+' + digits;
    return 'tel:' + digits;
  }

  const countryLabel = (codes) => (codes || []).map(countryName).join(' · ');

  /* ---------------- report service ----------------
     Contract: services/reports/README.md. Stats are read on every view;
     a report is only ever sent by a deliberate press of Save. The baked
     numbers in the payload are the floor — a slow, unreachable or
     unknown-slug response leaves them exactly as they are. */

  HP.reports = HP.reports || {
    base: 'https://humanplease-reports.sudhan2512.workers.dev',
    turnstileSiteKey: '0x4AAAAAAEnZ9QiRgppS6sOE',
  };

  const BUCKETS = {
    'lt_60': 'Under 1 min',
    '60_300': '1–5 min',
    '300_900': '5–15 min',
    'gt_900': '15 min+',
  };

  function nonce() {
    const b = new Uint8Array(16);
    if (!self.crypto || typeof self.crypto.getRandomValues !== 'function') {
      throw new Error('secure_random_unavailable');
    }
    self.crypto.getRandomValues(b);
    let s = '';
    for (const n of b) s += String.fromCharCode(n);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // A challenge that never calls back must not leave the button spinning.
  function withTimeout(promise, ms, reason) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(reason)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  let turnstile = null;

  // loaded on the first save, not on every page view
  function turnstileToken() {
    const key = HP.reports.turnstileSiteKey;
    if (!key) return Promise.resolve(null);

    if (!turnstile) {
      turnstile = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.onload = () => resolve(window.turnstile);
        s.onerror = () => reject(new Error('turnstile_unavailable'));
        document.head.appendChild(s);
      });
    }

    return turnstile.then((api) => new Promise((resolve, reject) => {
      const holder = document.createElement('div');
      holder.hidden = true;
      document.body.appendChild(holder);

      let widget = null;
      let settled = false;

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (widget !== null && api.remove) api.remove(widget); } catch (e) { /* already gone */ }
        holder.remove();
        fn(value);
      }

      const timer = setTimeout(() => finish(reject, new Error('turnstile_timeout')), 10000);

      try {
          widget = api.render(holder, {
            sitekey: key,
            size: 'invisible',
            action: 'phone-report',
          callback: (token) => finish(resolve, token),
          'error-callback': () => finish(reject, new Error('turnstile_failed')),
        });
        api.execute(widget);
      } catch (error) {
        finish(reject, error);
      }
    }));
  }

  HP.sendReport = function (body) {
    if (!HP.reports.base) return Promise.reject(new Error('no_endpoint'));
    return withTimeout(turnstileToken(), 12000, 'turnstile_timeout').then((token) =>
      withTimeout(fetch(HP.reports.base + '/v1/reports', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { 'X-Turnstile-Token': token } : {}
        ),
        body: JSON.stringify(body),
      }).then((r) => {
        if (!r.ok) throw new Error('http_' + r.status);
        return null;
      }), 15000, 'send_timeout')
    ).then(
      (stats) => stats,
      (error) => { throw error instanceof Error ? error : new Error('send_failed'); }
    );
  };

  /* ================= ROUTE PAGE ================= */

  /* Monoline icons, drawn to the same 1.6px weight as the rules.
     They mark what a row IS, so the eye can sort the page without
     reading it. Injected once, at the top of the rendered route. */
  const SPRITE =
    '<svg width="0" height="0" class="r-sprite" aria-hidden="true" focusable="false">' +
    '<symbol id="i-phone" viewBox="0 0 24 24"><path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 6.5 6.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3z"/></symbol>' +
    '<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/></symbol>' +
    '<symbol id="i-chat" viewBox="0 0 24 24"><path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/></symbol>' +
    '<symbol id="i-up" viewBox="0 0 24 24"><path d="M7 21V10l5-7a2.2 2.2 0 0 1 2 2.4L13 9h5.4A2 2 0 0 1 20.3 11.5l-1.6 7A3 3 0 0 1 15.8 21z"/><path d="M7 10H3.6v11H7z"/></symbol>' +
    '<symbol id="i-down" viewBox="0 0 24 24"><path d="M17 3v11l-5 7a2.2 2.2 0 0 1-2-2.4L11 15H5.6A2 2 0 0 1 3.7 12.5l1.6-7A3 3 0 0 1 8.2 3z"/><path d="M17 14h3.4V3H17z"/></symbol>' +
    '<symbol id="i-check" viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></symbol>' +
    '<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>' +
    '<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h13M13 6.5 18.5 12 13 17.5"/></symbol>' +
    '<symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9.5 6 6 6-6"/></symbol>' +
    '<symbol id="i-branch" viewBox="0 0 24 24"><path d="M6 3v7a4 4 0 0 0 4 4h8"/><path d="M14 10.5 18.5 14 14 17.5"/><circle cx="6" cy="20" r="1.6"/><path d="M6 14v4"/></symbol>' +
    '<symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/></symbol>' +
    '</svg>';

  const icon = (n, cls) =>
    '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + n + '"/></svg>';

  /* ---------- number identity ----------
     The same line is written a dozen ways across sources:
     "888 237 8289", "1-888-BEST-BUY (1-888-237-8289)", "+1 888 237 8289".
     Everything below compares the last ten digits of the dialable form,
     with vanity letters translated on the keypad. */

  const KEYPAD = {
    A: 2, B: 2, C: 2, D: 3, E: 3, F: 3, G: 4, H: 4, I: 4,
    J: 5, K: 5, L: 5, M: 6, N: 6, O: 6, P: 7, Q: 7, R: 7, S: 7,
    T: 8, U: 8, V: 8, W: 9, X: 9, Y: 9, Z: 9,
  };

  // Bengali, Devanagari, Arabic-Indic and friends are decimal digits too,
  // and a line written in them is still a line you can dial.
  const DIGIT_ZEROS = [
    0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6,
    0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x17e0,
    0x1810, 0xff10,
  ];

  function asciiDigits(value) {
    return String(value == null ? '' : value).replace(/[^\u0000-\u007F]/g, (ch) => {
      const cp = ch.codePointAt(0);
      for (const zero of DIGIT_ZEROS) {
        if (cp >= zero && cp <= zero + 9) return String(cp - zero);
      }
      return ch;
    });
  }

  function keypadDigits(token) {
    const up = asciiDigits(token).toUpperCase();
    return up.replace(/[A-Z]/g, (l) => (KEYPAD[l] == null ? '' : KEYPAD[l])).replace(/\D/g, '');
  }

  /* The one place a written number turns into digits. telHref and
     canonNumber both go through here, so a link and its identity can
     never disagree — which is exactly how a page ended up listing its
     own number twice. */
  function dialDigits(value) {
    const raw = asciiDigits(value).trim();
    if (!raw) return '';
    // a parenthesised numeric spelling is the authoritative one
    const paren = Array.from(raw.matchAll(/\(([^)]+)\)/g), (m) => m[1].replace(/\D/g, ''))
      .reverse().find((d) => d.length >= 7 && d.length <= 15);
    if (paren) return paren;
    return keypadDigits(raw.split(/\b(?:ext(?:ension)?|x)\b/i, 1)[0]);
  }

  // Two records name the same line when they dial the same digits. Inside
  // the NANP the country code is optional, so it is dropped; everywhere
  // else the whole number is the identity.
  function canonNumber(value) {
    const d = dialDigits(value);
    if (!d) return '';
    if (d.length === 11 && d.charAt(0) === '1') return d.slice(1);
    return d;
  }

  // A number written in prose carries no brackets to fall back on, and a
  // vanity spelling overruns: 1-844-GEEKSQUAD is nine letters over a
  // seven-digit tail. Drop the country code, keep what gets dialled.
  function canonToken(token) {
    const d = keypadDigits(token);
    if (!d) return '';
    if (d.length > 10) return (d.charAt(0) === '1' ? d.slice(1) : d).slice(0, 10);
    return d;
  }

  const sameNumber = (a, b) => {
    const x = canonNumber(a);
    return !!x && x === canonNumber(b);
  };

  // "1-844-GEEKSQUAD (1-844-433-5778)" reads as the number in the brackets
  function displayNumber(value) {
    const raw = String(value == null ? '' : value).trim();
    const paren = Array.from(raw.matchAll(/\(([^)]+)\)/g), (m) => m[1].trim())
      .reverse().find((t) => t.replace(/\D/g, '').length >= 7);
    return paren || raw;
  }

  const sentence = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');

  const heroNumber = (c) => c.raw || c.phone;
  const contactPhones = (c) => (c.contact && c.contact.phones) || [];
  const matchedContact = (c) => contactPhones(c).find((p) => sameNumber(p.e164 || p.raw, heroNumber(c))) || null;
  const trustedContact = (p) => !!p && (p.official || new Set(p.sources || []).size >= 2);
  const trustedPrimary = (c) => c.phoneTrust === 'official' || c.phoneTrust === 'corroborated';
  const trustLabel = (trust) => trust === 'official'
    ? 'Official source'
    : trust === 'corroborated' ? 'Matched by multiple sources' : 'Not independently verified';
  // how much a record actually tells us, for picking between duplicates
  const phoneWeight = (p) =>
    (p.official ? 8 : 0) + (p.sourceUrl ? 4 : 0) + (p.hours ? 2 : 0) + (p.use ? 1 : 0);

  function otherPhones(c) {
    const rest = contactPhones(c).filter((p) => !sameNumber(p.e164 || p.raw, heroNumber(c)));

    // sources list one line several times under different department names.
    // Keep the best-documented copy, in the position the first copy held.
    const order = [];
    const best = new Map();

    for (const p of rest) {
      const id = canonNumber(p.e164 || p.raw);
      if (!id) { order.push(p); continue; }
      const held = best.get(id);
      if (!held) {
        best.set(id, p);
        order.push(id);
      } else if (phoneWeight(p) > phoneWeight(held)) {
        best.set(id, p);
      }
    }

    return order.map((x) => (typeof x === 'string' ? best.get(x) : x));
  }

  /* ---------- the head line ---------- */

  // one statement about hours, from the most official source we hold
  function heroStatus(c) {
    const m = matchedContact(c);
    const raw = c.primaryHoursRaw || (m && m.hours) || null;

    if (raw) {
      const n = String(raw).trim().toLowerCase();
      if (n === '24/7' || n === '24x7' || n === '24 / 7' || n === '24 hours') {
        return { tone: 'ok', text: 'Open 24/7' };
      }
      const tz = c.primaryHoursTimezone || (m && m.timezone) || '';
      const named = /\b(ET|CT|MT|PT|EST|CST|MST|PST|GMT|UTC|BST|CET|IST|AEST)\b/i.test(raw);
      // an IANA zone name is a database key, not something to read out
      const abbr = /^[A-Z]{2,5}$/.test(String(tz).trim()) ? String(tz).trim() : '';
      return { tone: 'unk', text: 'Open ' + String(raw).replace(/\s*-\s*/g, '–') + (named || !abbr ? '' : ' ' + abbr) };
    }

    const h = c.hours;
    if (!h) return null;
    if (h.always) return { tone: 'ok', text: 'Open 24/7' };

    const i = todayIdx();
    const now = new Date();
    const t = now.getHours() + now.getMinutes() / 60;
    const today = h.days[i];

    if (today && t >= today[0] && t < today[1]) return { tone: 'ok', text: 'Open now — closes at ' + fmtHour(today[1]) };
    if (today && t < today[0]) return { tone: 'no', text: 'Closed — opens at ' + fmtHour(today[0]) + ' today' };
    for (let k = 1; k <= 7; k++) {
      const j = (i + k) % 7;
      if (h.days[j]) return { tone: 'no', text: 'Closed — opens ' + (k === 1 ? 'tomorrow' : DAYNAME[j]) + ' at ' + fmtHour(h.days[j][0]) };
    }
    return { tone: 'no', text: 'Closed right now' };
  }

  // what we know about time, in one line. never a sentence about what we don't.
  function timingLine(c) {
    const bits = [];
    if (c.total) bits.push('usually <b>' + human(c.total) + '</b> to a person');
    else if (c.hold) bits.push('about <b>' + human(c.hold) + '</b> on hold');
    else if (c.walk) bits.push('menu takes <b>' + human(c.walk) + '</b>');
    if (c.quiet) bits.push('quietest ' + esc(c.quiet));
    return bits.length ? '<p class="r-tim mono">' + bits.join(' &middot; ') + '</p>' : '';
  }

  function agoText(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const d = Math.floor((Date.now() - t) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 30) return d + ' days ago';
    const m = Math.round(d / 30);
    return m + (m === 1 ? ' month ago' : ' months ago');
  }

  // the standing on this route comes only from the reviewed, baked aggregate
  function tallyInner(v) {
    if (!v) return '';
    const up = v.up || 0;
    const down = v.down || 0;
    if (!up && !down) return '<p class="r-stamp mono">no reports yet</p>';

    const day = v.lastConfirmedDay || v.lastConfirmed;
    return '<div class="r-tallynums">' +
      '<span class="up">' + icon('up', 'fill') + ' ' + group(up) + '</span>' +
      '<span class="down">' + icon('down', 'fill') + ' ' + group(down) + '</span>' +
      '</div>' +
      (v.stale
        ? '<p class="r-stamp mono stale">not confirmed lately</p>'
        : day ? '<p class="r-stamp mono">confirmed ' + esc(agoText(day)) + '</p>' : '');
  }

  function tallyHTML(c) {
    return '<div class="r-tally" id="rtally">' + tallyInner(c.votes) + '</div>';
  }

  /* the instruction, as one line: dial this, press that */
  function actKeys(c) {
    const steps = c.steps || [];
    if (!steps.length) return { html: '', walk: false };

    const groups = groupSteps(steps);
    const keys = groups.every((g) => g.kind === 'press')
      ? groups.reduce((a, g) => a.concat(g.keys), [])
      : null;
    // a step can carry a note the keycap cannot show; the walkthrough can
    const noted = steps.some((s) => s.note);

    if (keys && keys.length <= 4) {
      return {
        html: '<span class="r-instr"><span class="r-then">then press</span>' +
          '<span class="r-keys">' + keys.map((k) => '<span class="cap">' + esc(k) + '</span>').join('') + '</span></span>',
        walk: keys.length > 1 || noted,
      };
    }

    return {
      html: '<span class="r-instr"><span class="r-then">' +
        steps.length + ' step' + (steps.length === 1 ? '' : 's') + ' to a person</span></span>',
      walk: true,
    };
  }

  function bandHTML(c) {
    const st = heroStatus(c) || { tone: '', text: '' };
    const act = actKeys(c);

    let h = '<header class="r-band">' +
      '<div class="r-idline"><div class="r-id">' +
      '<h1 class="r-co">' + esc(c.name) + '</h1>' +
      (c.country
        ? '<p class="r-sub"><img class="flagicon" src="' + esc(flagSrc(c.country)) + '" alt=""> ' +
          esc(c.countryName || countryName(c.country)) +
          (c.dept ? ' &middot; ' + esc(c.dept[0].toUpperCase() + c.dept.slice(1)) : '') + '</p>'
        : c.dept ? '<p class="r-sub">' + esc(c.dept[0].toUpperCase() + c.dept.slice(1)) + '</p>' : '') +
      '</div>' + tallyHTML(c) + '</div>';

    h += '<div class="r-act">';

    if (c.phone) {
      const href = trustedPrimary(c) ? telHref(heroNumber(c), c.country) : '';
      h += (href
        ? '<a class="dial" href="' + esc(href) + '" id="rdial">' +
          '<span class="num">' + esc(c.phone) + '</span>' +
          '<span class="go" aria-hidden="true">' + icon('arrow') + '</span></a>'
        : '<span class="dial nolink"><span class="num">' + esc(c.phone) + '</span></span>') +
        act.html +
        (act.walk ? '<button class="r-walk" type="button" id="startrun">Walk me through it</button>' : '');
    } else {
      h += '<p class="r-nophone">No public phone is on file for this line.</p>';
    }

    h += '<div class="r-when">' +
      (c.phone ? '<p class="r-trust ' + (trustedPrimary(c) ? '' : 'warn') + '">' + esc(trustLabel(c.phoneTrust)) + '</p>' : '') +
      (c.phone && st.text ? '<p class="status ' + st.tone + '">' + esc(st.text) + '</p>' : '') +
      timingLine(c) +
      '</div></div></header>';

    return h;
  }

  /* ---------- the ask ---------- */

  function padHTML(id, hint) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    return '<div class="r-pad" id="' + id + '">' +
      '<div class="r-padwrap">' +
      '<div class="r-seq" id="' + id + '-seq" data-hint="' + esc(hint) + '"><span class="ph">' + esc(hint) + '</span></div>' +
      '<div class="r-keys-pad">' +
      keys.map((k) => '<button type="button" data-k="' + esc(k) + '">' + (k === '*' ? '&lowast;' : esc(k)) + '</button>').join('') +
      '<button type="button" class="wide" data-w="said it">Said it</button>' +
      '<button type="button" class="wide" data-w="held">Held</button>' +
      '<button type="button" class="wide del" data-del="1">Undo</button>' +
      '</div></div></div>';
  }

  function chips(name, items) {
    return '<div class="r-chips" data-group="' + name + '">' +
      items.map((it) => '<button type="button" class="r-chip" data-v="' + esc(it.v) + '" aria-pressed="false">' + esc(it.label) + '</button>').join('') +
      '</div>';
  }

  function reportHTML(c) {
    if (!c.phone && !(c.steps && c.steps.length)) return '';

    const firstKeys = actKeys(c);
    const sameLabel = (c.steps && c.steps.length === 1 && c.steps[0].kind === 'press')
      ? 'Pressed ' + c.steps[0].key
      : 'Same as above';

    return '<section class="r-report" id="report">' +
      '<div class="r-reporthead">' +
      '<h2 class="r-q">Did you reach a person?</h2>' +
      '<div class="r-vote" id="rvote">' +
      '<button type="button" class="yes" data-v="yes" aria-pressed="false">' + icon('up', 'fill') + ' Yes</button>' +
      '<button type="button" class="no" data-v="no" aria-pressed="false">' + icon('down', 'fill') + ' No</button>' +
      '</div></div>' +
      '<p class="r-why">Every route here is only as current as the last person who answered this.</p>' +
      '<p class="r-dialled mono">You dialled a moment ago. One tap keeps this route alive.</p>' +

      /* yes */
      '<div class="r-follow" id="r-yes">' +
      '<div class="r-qgrid">' +
      '<div><p class="r-qlab r-eyebrow">' + icon('clock') + ' How long did it take?</p>' +
      chips('time', Object.keys(BUCKETS).map((k) => ({ v: k, label: BUCKETS[k] }))) + '</div>' +
      (c.steps && c.steps.length
        ? '<div><p class="r-qlab r-eyebrow">' + icon('branch') + ' Same steps? <span class="opt">optional</span></p>' +
          chips('steps', [{ v: 'same', label: sameLabel }, { v: 'different', label: 'Different' }]) + '</div>'
        : '') +
      '</div>' +
      (c.steps && c.steps.length ? padHTML('pad-yes', 'Tap what you actually pressed, in order.') : '') +
      '<div class="r-send"><button type="button" class="r-savebtn" data-save="yes">Save report</button>' +
      '<span class="r-sendnote">Sends this answer. A rotating network bucket limits repeat votes.</span></div>' +
      '<p class="r-thanks" data-thanks="1">' + icon('check') + ' Saved. Thank you.</p>' +
      '</div>' +

      /* no */
      '<div class="r-follow" id="r-no">' +
      '<div class="r-qgrid">' +
      '<div><p class="r-qlab r-eyebrow">' + icon('clock') + ' How long did you spend?</p>' +
      chips('time', Object.keys(BUCKETS).map((k) => ({ v: k, label: BUCKETS[k] }))) + '</div></div>' +
      '<div class="r-send"><button type="button" class="r-savebtn" data-save="no">Save report</button>' +
      '<span class="r-sendnote">Sends this answer. A rotating network bucket limits repeat votes.</span></div>' +
      '<p class="r-thanks" data-thanks="1">' + icon('check') + ' Saved. Thank you.</p>' +
      '</div>' +
      '</section>';
  }

  /* ---------- the fallback rail ---------- */

  // a note that repeats a number already printed as a row is noise
  function dedupedNotes(c) {
    const contact = c.contact || {};
    const raw = (contact.routingNotes || []).map((n) => (typeof n === 'string' ? n : JSON.stringify(n)));
    const shown = [canonNumber(heroNumber(c)), canonToken(heroNumber(c))]
      .concat(otherPhones(c).flatMap((p) => [canonNumber(p.e164 || p.raw), canonToken(p.raw)]))
      .filter(Boolean);

    return raw.filter((note) => {
      const tokens = String(note).split(/\s+/)
        .map((t) => t.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, ''))
        .filter((t) => /\d/.test(t) && t.replace(/[^0-9A-Za-z]/g, '').length >= 7);
      return !tokens.some((t) => {
        const id = canonToken(t);
        return id && (shown.indexOf(id) > -1 || shown.indexOf(canonNumber(t)) > -1);
      });
    });
  }

  function detailsBlock(ic, label, body) {
    return '<details class="r-more"><summary class="mono">' + icon(ic) + ' ' + esc(label) +
      icon('chev', 'chev') + '</summary><div>' + body + '</div></details>';
  }

  function railHTML(c) {
    const contact = c.contact || {};
    const others = otherPhones(c);
    const channels = (contact.channels || []).filter((ch) => ch && ch.url);
    const notes = dedupedNotes(c);
    const websites = (contact.websites || []).filter(Boolean);
    const emails = (contact.emails || []).filter(Boolean);
    const addresses = (contact.addresses || []).filter(Boolean);
    const alts = (c.alts || []).filter((a) => a.steps.length);
    const numbers = (!contactPhones(c).length && c.numbers && c.numbers.length > 1)
      ? c.numbers.filter((n) => new Set(n.sources || []).size >= 2 && telHref(n.n, c.country))
      : [];
    const bars = renderHours(c);

    if (!others.length && !notes.length && !channels.length && !websites.length &&
        !emails.length && !addresses.length && !alts.length && !numbers.length && !bars) return '';

    let h = '<aside class="r-rail"><h2 class="r-eyebrow">If this is not your line</h2>';

    h += others.map((p) => {
      const href = trustedContact(p)
        ? telHref(p.e164 || p.raw, c.country || (p.countries && p.countries.length === 1 ? p.countries[0] : null))
        : '';
      const dept = sentence(p.dept) || 'Customer support';
      // the department name and the "use" note are often the same string,
      // and the "use" note often opens by restating the hours
      const use = p.use && norm(p.use) !== norm(dept) ? p.use : '';
      const hours = p.hours && !(use && norm(use).indexOf(norm(p.hours)) > -1) ? p.hours : '';
      const foot = [hours, use].filter(Boolean);
      const sourceLabel = p.official ? 'official' : new Set(p.sources || []).size >= 2 ? 'matched sources' : 'unverified';
      const inner =
        '<div class="r-altop"><h3>' + esc(dept) + '</h3>' +
        '<span class="r-altnum mono">' + esc(displayNumber(p.raw)) + '</span></div>' +
        (foot.length || sourceLabel
          ? '<div class="r-altfoot mono">' +
            foot.map((f) => '<span>' + esc(f) + '</span>').join('') +
            '<span>' + esc(sourceLabel) + '</span>' +
            '</div>'
          : '');
      return href
        ? '<a class="r-altline" href="' + esc(href) + '">' + inner + '</a>'
        : '<div class="r-altline">' + inner + '</div>';
    }).join('');

    if (notes.length) {
      h += '<ul class="r-notes">' + notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>';
    }

    if (channels.length) {
      h += detailsBlock('chat', 'Chat and online (' + channels.length + ')',
        channels.map((ch) => {
          const hrs = ch.hours ? '<span class="hrs mono">' + esc(ch.hours) + '</span>' : '';
          const href = httpHref(ch.url);
          if (!href) return '';
          return '<a class="r-chan" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow">' +
            '<span class="nm">' + esc(ch.type || 'Official contact route') + '</span>' + hrs + '</a>';
        }).join(''));
    }

    if (websites.length || emails.length || addresses.length) {
      h += detailsBlock('globe', 'Other contact details',
        websites.map((u) => httpHref(u)).filter(Boolean).map((u) => '<a class="r-chan" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow"><span class="nm">Website</span></a>').join('') +
        emails.map((e) => '<a class="r-chan" href="mailto:' + esc(e) + '"><span class="nm">' + esc(e) + '</span></a>').join('') +
        addresses.map((a) => '<address class="r-chan"><span class="nm">' + esc(a) + '</span></address>').join(''));
    }

    if (alts.length) {
      h += detailsBlock('branch', 'Other ways in (' + alts.length + ')',
        alts.map((a) => {
          const keys = groupSteps(a.steps)
            .filter((s) => s.kind === 'press' || s.kind === 'say' || s.kind === 'enter')
            .map((s) => (s.keys
              ? s.keys.map((k) => '<span class="cap sm">' + esc(k) + '</span>').join('')
              : '<span class="chip">' + esc(s.key) + '</span>'))
            .join('');
          return '<div class="r-alt"><div class="r-altop"><h3>' + esc(a.dept) + '</h3>' +
            '<span class="r-altnum mono">' + (a.total ? esc(human(a.total)) : '') + '</span></div>' +
            (keys ? '<div class="r-altkeys">' + keys + '</div>' : '') + '</div>';
        }).join(''));
    }

    if (numbers.length) {
      h += detailsBlock('phone', 'Every number on file (' + numbers.length + ')',
        numbers.map((n) =>
          '<a class="r-chan" href="' + esc(telHref(n.n, c.country)) + '"><span class="nm">' + esc(n.dept || 'not labelled') +
          '</span><span class="hrs mono">' + esc(n.p) + '</span></a>').join(''));
    }

    if (bars) h += detailsBlock('clock', 'When somebody is there', bars);

    return h + '</aside>';
  }

  function routeHTML(c) {
    const rail = railHTML(c);
    const report = reportHTML(c);

    return SPRITE +
      bandHTML(c) +
      '<div class="r-cols' + (rail ? '' : ' solo') + '">' + report + rail + '</div>' +
      '<footer class="r-foot mono">' +
      '<span>' + (c.steps.length && c.sources.length
        ? 'Route from ' + c.sources.map(esc).join(' and ')
        : 'Sources are attached to each contact record') + '</span>' +
      (httpHref(c.url) ? '<a href="' + esc(httpHref(c.url)) + '" rel="noopener noreferrer nofollow" target="_blank">Original listing</a>' : '') +
      '</footer>';
  }

  /* ---------------- run mode ---------------- */

  let runEl = null;
  let runState = null;

  function ensureRun() {
    if (runEl) return runEl;
    runEl = document.createElement('div');
    runEl.className = 'run';
    runEl.setAttribute('role', 'dialog');
    runEl.setAttribute('aria-modal', 'true');
    runEl.setAttribute('aria-label', 'Walk the route');
    runEl.innerHTML =
      '<div class="rtop"><span class="lab" id="runco"></span><span class="grow"></span>' +
      '<span class="tick" id="runclock">0:00</span><span class="mono thin" id="runeta"></span></div>' +
      '<div class="rbody" id="runbody"></div>' +
      '<div class="ladder" id="runladder" aria-hidden="true"></div>' +
      '<div class="rfoot"><button class="next" id="runnext">Next step</button>' +
      '<button class="quit" id="runquit" aria-label="Close">&times;</button></div>';
    document.body.appendChild(runEl);

    $('#runnext', runEl).addEventListener('click', advance);
    $('#runquit', runEl).addEventListener('click', closeRun);

    addEventListener('keydown', (e) => {
      if (!runState) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRun(); }
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); advance(); }
      if (e.key === 'ArrowLeft' && runState.i > 0) { e.preventDefault(); runState.i--; paintRun(); }
    });

    return runEl;
  }

  function openRun(c) {
    ensureRun();
    const steps = c.steps.slice();
    if (c.hold) {
      steps.push({
        kind: 'wait', key: 'hold', secs: c.hold, last: true,
        note: 'Expect about ' + human(c.hold) + ' of hold music. Stay on.',
      });
    }

    runState = { c, steps, i: 0, t0: Date.now(), timer: null };
    runEl.classList.add('on');
    $('#runco').textContent = c.name;
    $('#runeta').textContent = c.total ? '/ ' + clk(c.total) + ' expected' : '';
    document.body.classList.add('modal-open');

    runState.timer = setInterval(() => {
      $('#runclock').textContent = clk((Date.now() - runState.t0) / 1000);
    }, 500);

    paintRun();
    $('#runnext').focus();
  }

  function paintRun() {
    const { steps, i } = runState;
    const done = i >= steps.length;

    $('#runladder').innerHTML = steps
      .map((x, n) => {
        const face = x.kind === 'press' ? x.key : x.kind === 'say' ? '"' : x.kind === 'wait' ? '~' : '.';
        return '<span class="rung' + (n < i ? ' past' : n === i ? ' now' : '') + '">' + esc(face) + '</span>';
      })
      .join('');

    const btn = $('#runnext');

    if (done) {
      $('#runbody').innerHTML =
        '<div class="rstep"><span class="lab">end of route</span>' +
        '<p class="say run-done">You should be with a person, or in the queue for one.</p>' +
        '<p class="note">If the menu did not match, go back and check the other ways in — companies re-cut ' +
        'these trees without warning.</p></div>';
      btn.textContent = 'Close';
      btn.classList.add('done');
      $('#runclock').classList.add('live');
      return;
    }

    const s = steps[i];
    $('#runbody').innerHTML =
      '<div class="rstep"><span class="lab">step ' + (i + 1) + ' of ' + steps.length + ' &middot; ' + KINDLAB[s.kind] + '</span>' +
      '<div class="run-face">' + stepFace(s, true) + '</div>' +
      (s.note ? '<p class="note">' + esc(s.note) + '</p>' : '') + '</div>';

    btn.classList.remove('done');
    btn.textContent = i === steps.length - 1 ? 'Done' : 'Next step';
  }

  function advance() {
    if (!runState) return;
    if (runState.i >= runState.steps.length) return closeRun();
    runState.i++;
    paintRun();
  }

  function closeRun() {
    if (!runState) return;
    clearInterval(runState.timer);
    runState = null;
    runEl.classList.remove('on');
    $('#runclock').classList.remove('live');
    document.body.classList.remove('modal-open');
    const b = $('#startrun');
    if (b) b.focus();
  }

  /* ---------------- mount ---------------- */

  HP.mountRoute = function (root, c) {
    document.title = c.name + ' — Human, Please';
    root.innerHTML = routeHTML(c);

    const start = $('#startrun', root);
    if (start) start.addEventListener('click', () => openRun(c));

    const report = $('#report', root);
    if (!report) return;

    const key = 'hp:fb:' + c.slug;
    const tally = $('#rtally', root);

    /* ---- the ask arms once ----
       Dormant while they are still reading. It wakes when they have
       something to report: they tapped the number and came back, or
       they have been on the page long enough to have dialled it from
       somewhere else. */
    let dwell = setTimeout(() => arm(false), 45000);

    function arm(scroll) {
      if (report.classList.contains('armed')) return;
      report.classList.add('armed');
      clearTimeout(dwell);
      if (scroll) report.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const dial = $('#rdial', root);
    if (dial) {
      dial.addEventListener('click', () => {
        // on a phone the tel: handoff backgrounds the page; arming on the
        // way back is the only moment they can actually answer
        setTimeout(() => arm(true), 900);
      });
    }

    /* ---- vote ---- */
    const branches = { yes: $('#r-yes', root), no: $('#r-no', root) };
    const answer = { v: null, time: null, steps: null, seq: [], nonce: null };

    function openBranch(v) {
      arm(false);
      answer.v = v;
      Object.keys(branches).forEach((k) => {
        if (branches[k]) branches[k].classList.toggle('on', k === v);
      });
      root.querySelectorAll('#rvote button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      markStale(v === 'no');
    }

    root.querySelectorAll('#rvote button').forEach((b) =>
      b.addEventListener('click', () => openBranch(b.dataset.v))
    );

    /* ---- single-select chip groups ---- */
    root.querySelectorAll('.r-chips').forEach((grp) => {
      grp.addEventListener('click', (e) => {
        const btn = e.target.closest('.r-chip');
        if (!btn) return;
        grp.querySelectorAll('.r-chip').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));

        const group = grp.dataset.group;
        if (group === 'time') answer.time = btn.dataset.v;
        const box = grp.closest('.r-follow');
        if (box) saveable(box);
        if (group === 'steps') {
          answer.steps = btn.dataset.v;
          const pad = $('#pad-yes', root);
          if (pad) pad.classList.toggle('on', btn.dataset.v === 'different');
        }
      });
    });

    /* ---- tap the tree instead of describing it ---- */
    function wirePad(padId, bucket) {
      const pad = $('#' + padId, root);
      if (!pad) return;
      const seq = $('#' + padId + '-seq', pad);
      const hint = seq.dataset.hint;

      function paint() {
        if (!bucket.length) { seq.innerHTML = '<span class="ph">' + esc(hint) + '</span>'; return; }
        seq.innerHTML = bucket
          .map((it) => (it.kind === 'press'
            ? '<span class="cap sm">' + esc(it.key) + '</span>'
            : '<span class="word">' + esc(it.key) + '</span>'))
          .join('<span class="arw">&#9656;</span>');
      }

      pad.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.del) bucket.pop();
        else if (b.dataset.k) bucket.push({ kind: 'press', key: b.dataset.k });
        else if (b.dataset.w) bucket.push({ kind: b.dataset.w === 'held' ? 'wait' : 'say', key: b.dataset.w });
        else return;
        paint();
      });
    }

    wirePad('pad-yes', answer.seq);

    /* ---- save ----
       Built to schema/phone-report.schema.json. A duration is required by
       the service, so Save stays disabled until one is picked. The answer
       is written to this device first: if the network fails, the person
       still sees their own verdict on the next visit. */

    function buildReport(v) {
      const body = {
        schemaVersion: 1,
        slug: c.slug,
        reachedHuman: v === 'yes',
        secondsBucket: answer.time,
        stepsMatched: answer.steps !== 'different',
        clientNonce: answer.nonce || (answer.nonce = nonce()),
      };

      // steps are only meaningful, and only accepted, when they differed
      if (v === 'yes' && answer.steps === 'different' && answer.seq.length) {
        body.steps = answer.seq.slice(0, 12).map((st) =>
          (st.kind === 'press' ? { kind: 'press', key: st.key } : { kind: st.kind }));
      }

      if (v === 'no') {
        body.stepsMatched = false;
      }

      return body;
    }

    function saveable(box) {
      const btn = $('.r-savebtn', box);
      if (!btn) return;
      const ready = !!answer.time;
      btn.disabled = !ready;
      btn.setAttribute('aria-disabled', String(!ready));
      const note = $('.r-sendnote', box);
      if (note) note.textContent = ready ? note.dataset.ready : 'Pick how long it took first.';
    }

    root.querySelectorAll('.r-sendnote').forEach((n) => { n.dataset.ready = n.textContent; });
    root.querySelectorAll('.r-follow').forEach(saveable);

    root.querySelectorAll('[data-save]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.disabled) return;
        const v = b.dataset.save;
        const box = b.closest('.r-follow');
        const send = $('.r-send', box);
        const thanks = $('[data-thanks]', box);

        const rec = {
          v: v,
          at: Date.now(),
          time: answer.time || null,
          steps: answer.steps || null,
          seq: answer.seq.length ? answer.seq : null,
        };
        try { localStorage.setItem(key, JSON.stringify(rec)); } catch (e) { /* private mode */ }
        paintTally(rec);

        b.disabled = true;
        b.textContent = 'Sending…';

        Promise.resolve().then(() => HP.sendReport(buildReport(v))).then(
          () => {
            if (send) send.hidden = true;
            if (thanks) { thanks.classList.add('on'); thanks.classList.remove('failed'); }
          },
          () => {
            // the report is on the device; say so rather than claiming success
            b.disabled = false;
            b.textContent = 'Try sending again';
            if (thanks) {
              thanks.classList.add('on', 'failed');
              thanks.innerHTML = icon('x') + ' Saved here, but the report did not reach the site.';
            }
          }
        );
      })
    );

    /* ---- a stale route has to say so, here and on every later visit ---- */
    const stamp = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

    function markStale(on) {
      const old = $('.r-stale', root);
      if (old) old.remove();
      if (!on) return;
      const band = $('.r-act', root);
      if (!band) return;
      const p = document.createElement('p');
      p.className = 'r-stale';
      p.textContent = 'You marked this route wrong. The steps above are unchanged — try the other lines.';
      band.parentNode.insertBefore(p, band.nextSibling);
    }

    function paintTally(rec) {
      if (!tally || (c.votes && (c.votes.up || c.votes.down))) return;
      tally.innerHTML = '<p class="r-stamp mono">you ' +
        (rec.v === 'yes' ? 'confirmed' : 'flagged') + ' this on ' + stamp(rec.at) + '</p>';
    }

    /* ---- what this device said last time ---- */
    let prior = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) prior = raw[0] === '{' ? JSON.parse(raw) : { v: raw, at: Date.now() };
    } catch (e) { /* private mode, or a corrupt entry */ }

    if (prior) {
      arm(false);
      root.querySelectorAll('#rvote button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === prior.v)));
      markStale(prior.v === 'no');
      paintTally(prior);
    }
  };

  /* exposed so scripts/check-route-pages.mjs can render every payload
     without a browser */
  HP.routeHTML = routeHTML;
  HP.canonNumber = canonNumber;

  HP.notFound = function (root, what) {
    root.innerHTML =
      '<section class="head"><h2 class="co">' + esc(what) + '</h2>' +
      '<p class="muted gap"><a href="index.html">Search again</a>.</p></section>';
  };

  HP.closeRun = closeRun;
})();
