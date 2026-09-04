// bundle.mjs — folds the whole site into one self-contained HTML file.
// Same CSS, same core.js, same data; hash routing instead of separate pages.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

const css = read('assets/base.css');
const flags = read('assets/flags.css');
const fontCss = read('assets/fonts.css').replace(/url\(fonts\/([^)]+)\)/g, (_match, file) =>
  `url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'assets', 'fonts', file)).toString('base64')})`
);
const core = read('assets/core.js');
const index = JSON.parse(read('data/index.json'));
const stats = JSON.parse(read('data/stats.json'));

const routes = {};
for (const f of fs.readdirSync(path.join(ROOT, 'data', 'r'))) {
  Object.assign(routes, JSON.parse(read(path.join('data', 'r', f))));
}
const flagData = {};
for (const file of fs.readdirSync(path.join(ROOT, 'assets', 'flags'))) {
  if (!file.endsWith('.svg')) continue;
  flagData[path.basename(file, '.svg').toUpperCase()] = `data:image/svg+xml;base64,${fs.readFileSync(path.join(ROOT, 'assets', 'flags', file)).toString('base64')}`;
}
const aliases = {};
for (const route of Object.values(routes)) {
  if (!route.baseSlug) continue;
  const priority = route.country === 'CA' ? 0 : route.country === 'US' ? 1 : 2;
  if (!aliases[route.baseSlug] || priority < aliases[route.baseSlug].priority) aliases[route.baseSlug] = { slug: route.slug, priority };
}

// `<` never appears outside a JSON string, so escaping it wholesale is safe
// and keeps </script> from ending the tag early
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

let html = `<meta charset="utf-8">
<title>Human, Please</title>
<meta name="description" content="Phone numbers, published hours, chat links, contact routes and mapped phone menus for ${stats.companies.toLocaleString('en-US')} companies.">
<style>
${fontCss}
${css}
${flags}
[hidden] { display: none !important; }
</style>

<div class="sheet" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<div class="rails" aria-hidden="true"><div class="wrap"><i></i><i></i></div></div>

<header class="bar">
  <div class="wrap">
    <a class="mark" href="#" id="home-link">Human<em>,</em> Please</a>
    <span class="grow"></span>
    <a class="back mono" href="#" id="barback" hidden><span class="arw">&larr;</span> Search again</a>
  </div>
</header>

<main class="stage" id="stage">
  <div class="wrap ask">
    <h1 class="q wide">Who do you wanna call today<b>?</b></h1>

    <div class="field" id="field">
      <label for="q" class="lab sr-only">Company name</label>
      <input id="q" type="search" autocomplete="off" autocapitalize="off" spellcheck="false"
             placeholder="start typing a company" enterkeyhint="search">
      <span class="mono count" id="hits"></span>
      <span class="rule"></span>
    </div>

    <div class="tray" id="tray">
      <div class="scroll" id="results" role="listbox" aria-label="Matching companies"></div>
    </div>
  </div>

  <div class="wrap">
    <div class="counts" id="counts">
      <div><span class="n">0</span><span class="c">total companies and services</span></div>
      <div><span class="n">0</span><span class="c">total phone numbers</span></div>
      <div><span class="n">0</span><span class="c">countries and territories</span></div>
    </div>
  </div>

  <div class="tone" aria-hidden="true">
    <svg viewBox="0 0 1200 34" preserveAspectRatio="none">
      <g class="amp">
        <g class="drift" fill="none" stroke="#c9c8d4" stroke-width="1">
          <path d="M0 17 Q 25 3 50 17 T 100 17 T 150 17 T 200 17 T 250 17 T 300 17 T 350 17 T 400 17 T 450 17 T 500 17 T 550 17 T 600 17 T 650 17 T 700 17 T 750 17 T 800 17 T 850 17 T 900 17 T 950 17 T 1000 17 T 1050 17 T 1100 17 T 1150 17 T 1200 17"/>
        </g>
      </g>
    </svg>
  </div>

  <div class="wrap">
    <p class="foot mono">
      <a href="#/about">How this is put together</a>
    </p>
  </div>
</main>

<main id="page" class="wrap" hidden></main>

<main id="about" class="wrap" hidden>
  <section class="head"><h2 class="co">How this<br>is put together</h2></section>

  <section class="sec prose">
    <h3>Where the contact details come from</h3>
    <p>Phone-menu reports are combined with company contact records, official support pages and
      official documents. One hundred major US and Canadian services also have a manual research
      pass covering department lines, hours, chat, messaging and callback routes.</p>

    <h3>What the times mean</h3>
    <p>Every route has two parts and they are estimated differently.</p>
    <ul>
      <li><b>Working the menu</b> is calculated: four seconds per keypress, five to say a phrase,
        nine to key in an account number, fifteen for a prompt you have to sit through.</li>
      <li><b>On hold</b> is reported — the wait time the source lists for that line. It is an average
        of other people's calls, not a promise about yours.</li>
    </ul>
    <p>Where a line has no reported hold, the page says so instead of quietly showing a fast number.</p>

    <h3>What "confirmed" means</h3>
    <p>A route marked <b>confirmed</b> has two or more written steps recorded against it. A
      <b>single reported route</b> came from one source and one person's memory. Companies re-cut their
      phone trees without telling anyone, so a route that fails is normal. Use the department and
      issue labels to choose the relevant line.</p>

    <h3>What is missing</h3>
    <p>Many companies publish contact details without publishing their phone-menu steps. Those pages
      show the available phone, chat, form, email or website routes and state that the menu is not mapped.</p>

    <h3>What this site does with you</h3>
    <p>No account, analytics or advertising cookies. If you save an answer, it sends only the choices shown; a rotating, pseudonymous network
      bucket limits repeat votes and is deleted with the report after 30 days.</p>

    <h3>Coverage</h3>
    <p class="mono thin">${stats.companies.toLocaleString('en-US')} companies &middot; ${stats.numbers.toLocaleString('en-US')} phone records &middot; ${stats.contactChannels.toLocaleString('en-US')} online contact routes &middot; ${stats.withSteps.toLocaleString('en-US')} mapped menus &middot; rebuilt ${stats.built}</p>
  </section>

  <footer class="pagefoot mono"><a href="#">Search</a></footer>
</main>

<script>
window.HP = { flagData: ${json(flagData)} };
${core}
</script>

<script id="D" type="application/json">${json({ index, stats, routes, aliases })}</script>

<script>
(function () {
  const D = JSON.parse(document.getElementById('D').textContent);
  const stage = document.getElementById('stage');
  const page = document.getElementById('page');
  const about = document.getElementById('about');
  const back = document.getElementById('barback');

  HP.mountSearch({ index: D.index, stats: D.stats, href: (s) => '#/c/' + s });

  function show(el) {
    for (const v of [stage, page, about]) v.hidden = v !== el;
    back.hidden = el === stage;
    scrollTo(0, 0);
  }

  function router() {
    const h = location.hash;

    if (h.startsWith('#/c/')) {
      const slug = decodeURIComponent(h.slice(4));
      if (!D.routes[slug] && D.aliases[slug]) {
        history.replaceState(null, '', '#/c/' + D.aliases[slug].slug);
        router();
        return;
      }
      const c = D.routes[slug];
      show(page);
      if (c) HP.mountRoute(page, c);
      else page.innerHTML = '<section class="head"><h2 class="co">Not on file</h2>' +
        '<p class="muted gap"><a href="#">Search again</a>.</p></section>';
      return;
    }

    if (h === '#/about') {
      show(about);
      document.title = 'How this is put together — Human, Please';
      return;
    }

    show(stage);
    document.title = 'Human, Please';
    HP.closeRun();
  }

  addEventListener('hashchange', router);
  document.getElementById('home-link').addEventListener('click', () => { location.hash = ''; });
  back.addEventListener('click', () => { location.hash = ''; });
  router();
})();
</script>
`;

const inlineScriptHashes = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi), (match) =>
  `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`
);
const inlineStyleHashes = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi), (match) =>
  `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`
);
const csp = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  `script-src ${inlineScriptHashes.join(' ')} https://challenges.cloudflare.com`,
  "script-src-attr 'none'",
  `style-src ${inlineStyleHashes.join(' ')}`,
  "style-src-attr 'none'",
  "font-src data:",
  "img-src data:",
  "connect-src https://humanplease-reports.sudhan2512.workers.dev",
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'none'",
].join('; ');
html = html.replace('<meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta charset="utf-8">`);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'human-please.html');
fs.writeFileSync(out, html);
console.log('wrote', out, (fs.statSync(out).size / 1024 / 1024).toFixed(2) + ' MB');
