const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ATS_NAMES = { site: 'Company careers page', greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable' };

function ago(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  if (isNaN(d)) return '';
  if (d <= 0) return 'Posted today';
  if (d === 1) return 'Posted yesterday';
  if (d < 60) return `Posted ${d} days ago`;
  return `Posted ${Math.floor(d / 30)} months ago`;
}

function safeUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : '#'; } catch { return '#'; }
}

function renderJobs(data) {
  $('#count').textContent = `${data.total.toLocaleString()} open roles`;
  if (!data.jobs.length) {
    $('#jobs').innerHTML = '<li class="empty">No matching openings. Try fewer keywords, a wider date range, or add more companies.</li>';
    return;
  }
  $('#jobs').innerHTML = data.jobs.map((j) => {
    const open = j.postedAt ? Math.floor((Date.now() - Date.parse(j.postedAt)) / 864e5) : 0;
    const old = open > 90;
    return `<li class="job">
      <h3><a href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a></h3>
      <div class="meta">
        <strong>${esc(j.company)}</strong>
        <span>${esc(j.location)}</span>
        ${j.department ? `<span>${esc(j.department)}</span>` : ''}
        ${j.employmentType ? `<span>${esc(j.employmentType)}</span>` : ''}
        ${j.postedAt ? `<span>${esc(ago(j.postedAt))}</span>` : ''}
      </div>
      ${j.snippet ? `<p class="snippet">${esc(j.snippet)}…</p>` : ''}
      <div class="badges">
        <span class="badge ok" title="Found by scanning ${esc(j.companyDomain)}">✓ From ${esc(j.companyDomain)}${j.source === 'site' ? '' : ` via ${esc(ATS_NAMES[j.source] || j.source)}`}</span>
        ${j.remote ? '<span class="badge">Remote</span>' : ''}
        ${old ? `<span class="badge warn" title="Roles open this long are often already filled. Check with the company before investing a lot of time.">⚠ Open ${open} days, may be filled${j.companyNudgedAt ? ' · company notified' : ''}</span>` : ''}
      </div>
    </li>`;
  }).join('');
}

function renderCompanies(list) {
  $('#companies').innerHTML = list.length ? list.map((c) => `<li>
    <div>
      <div><strong>${esc(c.name)}</strong> ${c.verified ? '<span title="Job board verified on company website">✓</span>' : ''}</div>
      ${c.pending ? '<div class="muted">Scanning website…</div>'
        : c.boards.length ? `<div class="muted">${esc(c.domain)} · ${c.jobCount} jobs · ${esc(c.boards.map((b) => ATS_NAMES[b.ats] || b.ats).join(', '))}</div>` : ''}
      ${c.error ? `<div class="err">${c.boards.length ? "Couldn't load jobs" : 'Website check failed'}: ${esc(c.error)}</div>` : ''}
    </div>
    <button type="button" data-remove="${esc(c.domain)}" aria-label="Remove ${esc(c.name)}" title="Remove">✕</button>
  </li>`).join('') : '<li class="muted">No companies yet. Add one above.</li>';
}

async function load(refresh = false) {
  const params = new URLSearchParams(new FormData($('#search')));
  if (refresh) params.set('refresh', '1');
  $('#count').textContent = refresh ? 'Checking company job boards…' : 'Loading…';
  try {
    const res = await fetch('/api/jobs?' + params);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderJobs(data);
    renderCompanies(data.companies);
    renderAlert(data.alert);
    clearTimeout(window._poll);
    if (data.companies.some((c) => c.pending)) window._poll = setTimeout(load, 4000);
  } catch (e) {
    $('#count').textContent = 'Could not load jobs: ' + e.message;
  }
}

$('#search').addEventListener('submit', (e) => { e.preventDefault(); load(); });
$('#search').addEventListener('change', (e) => { if (e.target.type !== 'search') load(); });
$('#refresh').addEventListener('click', () => load(true));

$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = form.querySelector('button'), msg = $('#addMsg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Scanning website for an official careers board…';
  try {
    const res = await fetch('/api/companies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ website: form.website.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.className = 'msg ok';
    msg.textContent = `Added ${data.company.name}: ${data.jobCount} open roles found on its official board.`;
    form.reset();
    load();
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = err.message;
  } finally { btn.disabled = false; }
});

$('#companies').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-remove]')?.dataset.remove;
  if (!d) return;
  await fetch('/api/companies/' + encodeURIComponent(d), { method: 'DELETE' });
  load();
});

load();

// ---------- Employer review ----------
function showView(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  for (const v of ['jobs', 'check', 'review']) $('#view-' + v).hidden = name !== v;
  if (name === 'review') loadReview();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('#staleDays').addEventListener('change', loadReview);

let review = [];

async function loadReview() {
  $('#reviewList').innerHTML = '<li class="empty">Checking every company for long-open postings…</li>';
  try {
    const res = await fetch('/api/stale?days=' + $('#staleDays').value);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    review = data.companies;
    renderReview(data);
  } catch (e) {
    $('#reviewList').innerHTML = `<li class="empty">Could not load the review: ${esc(e.message)}</li>`;
  }
}

function renderReview(data) {
  const pending = data.companies.filter((c) => c.canNudge).length;
  $('#staleBadge').hidden = !data.companies.length;
  $('#staleBadge').textContent = data.companies.length;
  $('#reviewSummary').innerHTML = `
    <div class="stat"><b>${data.companies.length}</b>companies</div>
    <div class="stat"><b>${data.staleJobs}</b>old posts</div>
    <div class="stat"><b>${pending}</b>to notify</div>`;
  if (!data.companies.length) {
    $('#reviewList').innerHTML = `<li class="empty">No company has a job posted for more than ${data.days} days. 🎉</li>`;
    return;
  }
  $('#reviewList').innerHTML = data.companies.map((c, i) => `
    <li class="rcard ${c.canNudge ? '' : 'done'}">
      <header>
        <h3>${esc(c.name)} <span class="muted" style="font-weight:400;font-size:14px">${esc(c.domain)}</span></h3>
        <span class="muted">${c.staleCount} of ${c.totalJobs} posts open more than ${data.days} days · oldest ${c.oldestDays} days</span>
      </header>
      <ul class="stale-jobs">
        ${c.staleJobs.slice(0, 8).map((j) => `<li><a href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a><span class="days">${j.daysOpen} days</span></li>`).join('')}
        ${c.staleJobs.length > 8 ? `<li class="muted">…and ${c.staleJobs.length - 8} more</li>` : ''}
      </ul>
      ${csatLine(c.csat)}
      ${c.lastNudge ? `<p class="muted">✓ Note sent ${esc(new Date(c.lastNudge.at).toLocaleDateString())}${c.lastNudge.to ? ' to ' + esc(c.lastNudge.to) : ''}.${c.canNudge ? ' Still open, so a follow-up is due.' : ' Follow-up available 30 days after the last note.'}</p>` : ''}
      <details class="note" ${c.canNudge && i === 0 ? 'open' : ''}>
        <summary>${c.canNudge ? 'Review the note to the company' : 'View the note'}</summary>
        <label for="to${i}">Send to</label>
        <input id="to${i}" data-to="${i}" value="${esc(c.contacts[0] || '')}" placeholder="No hiring email found on their site. Add one, or use the careers page link.">
        <label for="subj${i}">Subject</label>
        <input id="subj${i}" data-subj="${i}" value="${esc(c.note.subject)}">
        <label for="body${i}">Message (edit freely)</label>
        <textarea id="body${i}" data-body="${i}">${esc(c.note.body)}</textarea>
        <div class="actions">
          <button type="button" data-email="${i}">Open in my email</button>
          <button type="button" class="secondary" data-copy="${i}">Copy note</button>
          <a href="${esc(safeUrl(c.careersUrl))}" target="_blank" rel="noopener noreferrer">Their careers page ↗</a>
          <button type="button" class="link" data-mark="${i}">Mark as sent</button>
          <span class="msg" data-msg="${i}"></span>
        </div>
      </details>
    </li>`).join('');
}

async function markSent(i) {
  const c = review[i];
  await fetch(`/api/companies/${encodeURIComponent(c.domain)}/nudge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobIds: c.staleJobs.map((j) => j.id), to: document.querySelector(`[data-to="${i}"]`).value }),
  });
  loadReview();
}

$('#reviewList').addEventListener('click', async (e) => {
  const t = e.target;
  const i = t.dataset.email ?? t.dataset.copy ?? t.dataset.mark;
  if (i === undefined) return;
  const to = document.querySelector(`[data-to="${i}"]`).value.trim();
  const subject = document.querySelector(`[data-subj="${i}"]`).value;
  const body = document.querySelector(`[data-body="${i}"]`).value;
  const msg = document.querySelector(`[data-msg="${i}"]`);
  if (t.dataset.copy !== undefined) {
    try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); msg.textContent = 'Copied. Paste it into their contact form or email.'; }
    catch { msg.textContent = 'Copy failed. Select the text and copy it manually.'; }
  } else if (t.dataset.email !== undefined) {
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    msg.textContent = 'Opened in your email app. Click "Mark as sent" once you\'ve sent it.';
  } else {
    markSent(Number(i));
  }
});

// Show the count on the tab right away.
fetch('/api/stale?days=90').then((r) => r.json()).then((d) => {
  $('#staleBadge').hidden = !d.companies?.length; $('#staleBadge').textContent = d.companies?.length || '';
}).catch(() => {});

// ---------- Company check + recruiting CSAT ----------
const VERDICT = { verified: '✅ Looks real', caution: '⚠️ Be careful', warning: '⛔ Warning: may not be real' };
const STAGE_NAMES = { applied: 'Applied', screen: 'Phone screen', interview: 'Interviews', final: 'Final round', offer: 'Got an offer' };

function clientId() {
  try {
    let id = localStorage.getItem('rjf-id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('rjf-id', id); }
    return id;
  } catch { return (window._rid ||= crypto.randomUUID()); }
}

function csatLine(c) {
  if (!c || !c.count) return '<p class="muted">Recruiting CSAT: no candidate ratings yet.</p>';
  if (c.csat === null) return `<p class="muted">Recruiting CSAT: ${c.count} rating${c.count === 1 ? '' : 's'} so far (avg ${c.average}★). A score shows after ${c.minForScore}.</p>`;
  return `<p class="muted">Recruiting CSAT: <strong>${c.csat}% satisfied</strong> · ${c.average}★ avg · ${c.count} ratings${c.ghostedPct !== null ? ` · ${c.ghostedPct}% ghosted` : ''}</p>`;
}

function csatBlock(c) {
  if (!c || !c.count) return '<p class="muted">No candidate has rated this recruiting team yet. Be the first.</p>';
  const stat = (v, label) => `<div class="stat"><b>${v ?? '–'}</b>${label}</div>`;
  return `<div class="csat">
      ${stat(c.csat !== null ? c.csat + '%' : '–', 'CSAT (4–5★)')}
      ${stat(c.average + '★', 'average')}
      ${stat(c.respondedPct !== null ? c.respondedPct + '%' : '–', 'got a reply')}
      ${stat(c.ghostedPct !== null ? c.ghostedPct + '%' : '–', 'were ghosted')}
      ${stat(c.respectfulPct !== null ? c.respectfulPct + '%' : '–', 'felt respected')}
      ${stat(c.count, c.count === 1 ? 'rating' : 'ratings')}
    </div>
    ${c.csat === null ? `<p class="muted">Percentages appear once ${c.minForScore} candidates have rated.</p>` : ''}
    ${c.recent.map((r) => `<div class="quote">${'★'.repeat(r.score)}${'☆'.repeat(5 - r.score)} ${r.stage ? `<span class="muted">${esc(STAGE_NAMES[r.stage])} ·</span>` : ''} “${esc(r.comment)}” <span class="muted">${esc(new Date(r.at).toLocaleDateString())}</span></div>`).join('')}`;
}

function rateForm(domain) {
  const yn = (name, q) => `<span>${q} <label><input type="radio" name="${name}" value="true"> Yes</label> <label><input type="radio" name="${name}" value="false"> No</label></span>`;
  return `<form class="rate-form" data-domain="${esc(domain)}">
    <div class="row"><strong>How was your experience with their recruiting team?</strong>
      <span class="stars" role="radiogroup" aria-label="Rating">
        ${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="s${n}" name="score" value="${n}" required><label for="s${n}" title="${n} star${n > 1 ? 's' : ''}">★</label>`).join('')}
      </span></div>
    <div class="row">
      <label>How far did you get? <select name="stage"><option value="">Choose…</option>${Object.entries(STAGE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    </div>
    <div class="row">${yn('responded', 'Did they reply to you?')} ${yn('ghosted', 'Did they stop replying partway?')} ${yn('respectful', 'Were they respectful of your time?')}</div>
    <textarea name="comment" maxlength="500" placeholder="Optional: share a short tip for other candidates. Don't include names or personal details."></textarea>
    <div class="row"><button type="submit">Submit rating</button><span class="msg" data-rate-msg></span></div>
  </form>`;
}

function renderCheck(r) {
  const p = r.profile;
  const head = r.type === 'job'
    ? `<h3>${r.job ? esc(r.job.title) : 'Job link'}${r.company ? ` at ${esc(r.company.name)}` : ''}</h3><div class="muted" style="word-break:break-all">${esc(r.link)}</div>`
    : `<h3>${esc(r.name)} <span class="muted" style="font-weight:400;font-size:14px">${esc(r.domain)}</span></h3>
       <div class="muted">${r.jobCount} live jobs found${r.domainRegisteredAt ? ` · website registered ${esc(new Date(r.domainRegisteredAt).getFullYear())}` : ''}</div>`;
  const linkFlags = p?.check?.linkFlags?.length && r.type === 'company'
    ? `<p class="muted" style="margin-top:10px">⚠️ People have checked ${p.check.linkFlags.length} job link${p.check.linkFlags.length === 1 ? '' : 's'} claiming to be from this company that we could not confirm.</p>` : '';
  $('#checkResult').innerHTML = `
    <div class="verdict ${esc(r.verdict)}">
      <div class="vlabel">${VERDICT[r.verdict]}</div>
      ${head}
      <ul class="flags">${r.flags.map((f) => `<li class="${esc(f.level)}">${esc(f.text)}</li>`).join('')}</ul>
      ${linkFlags}
      ${r.job ? `<p><a href="${esc(safeUrl(r.job.url))}" target="_blank" rel="noopener noreferrer">Open the official posting ↗</a></p>` : ''}
    </div>
    ${p ? `<div class="card">
      <h2>Recruiting team CSAT: ${esc(p.name)}</h2>
      <div class="csat-wrap">${csatBlock(p.csat)}</div>
      <hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
      ${rateForm(p.domain)}
    </div>` : ''}`;
}

$('#checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  $('#checkResult').innerHTML = '<p class="muted">Checking the company website and its official job listings…</p>';
  try {
    const res = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: e.target.query.value }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    renderCheck(data);
  } catch (err) {
    $('#checkResult').innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
});

$('#checkResult').addEventListener('submit', async (e) => {
  if (!e.target.matches('.rate-form')) return;
  e.preventDefault();
  const f = new FormData(e.target);
  const tri = (k) => (f.get(k) === 'true' ? true : f.get(k) === 'false' ? false : null);
  const msg = e.target.querySelector('[data-rate-msg]');
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(e.target.dataset.domain)}/ratings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: Number(f.get('score')), stage: f.get('stage'), responded: tri('responded'), ghosted: tri('ghosted'), respectful: tri('respectful'), comment: f.get('comment'), clientId: clientId(), termsVersion: TERMS_VERSION }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.className = 'msg ok'; msg.textContent = 'Thanks! Your rating helps other job seekers.';
    e.target.closest('.card').querySelector('.csat-wrap').innerHTML = csatBlock(data);
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// Warning banner in job search when the searched company has been flagged.
function renderAlert(a) {
  const box = $('#alert');
  if (!a || (!a.check && !a.csat?.count)) { box.innerHTML = ''; return; }
  const v = a.check?.verdict || 'verified';
  const top = (a.check?.flags || []).filter((f) => f.level === 'high' || f.level === 'medium').slice(0, 2);
  const links = a.check?.linkFlags?.length || 0;
  if (v === 'verified' && !links && !a.csat?.count) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="banner ${links && v === 'verified' ? 'caution' : esc(v)}">
    <strong>${esc(a.name)}:</strong> ${v === 'verified' ? 'company website and job listings check out.' : esc(VERDICT[v])}
    ${top.map((f) => `<div>• ${esc(f.text)}</div>`).join('')}
    ${links ? `<div>• ${links} job link${links === 1 ? '' : 's'} using this company's name could not be confirmed on its official listings. Apply only through the company's own site.</div>` : ''}
    ${a.csat?.count ? `<div>${csatLine(a.csat).replace(/<\/?p[^>]*>/g, '')}</div>` : ''}
  </div>`;
}

// ---------- Footer: feedback + delete my data ----------
function openDialog(name) {
  const d = document.getElementById('dlg-' + name);
  if (d && !d.open) d.showModal();
}
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) { e.preventDefault(); openDialog(o.dataset.open); }
  if (e.target.matches('[data-close]')) e.target.closest('dialog').close();
});
// Links like /#feedback from the Privacy and Terms pages.
if (['#feedback', '#delete'].includes(location.hash)) openDialog(location.hash.slice(1));

$('#feedbackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target), msg = $('#fbMsg');
  try {
    const res = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: f.get('topic'), message: f.get('message'), replyTo: f.get('replyTo'), clientId: clientId() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msg.className = 'msg ok'; msg.textContent = 'Thank you, your feedback was sent.';
    e.target.reset();
    setTimeout(() => { $('#dlg-feedback').close(); msg.textContent = ''; }, 1500);
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

$('#deleteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#delMsg');
  let id = null;
  try { id = localStorage.getItem('rjf-id'); } catch { /* storage blocked */ }
  try {
    let text = 'There was nothing stored for this browser.';
    if (id) {
      const res = await fetch('/api/my-data', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: id }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      text = `Deleted ${data.ratingsRemoved} rating${data.ratingsRemoved === 1 ? '' : 's'} and ${data.feedbackRemoved} feedback message${data.feedbackRemoved === 1 ? '' : 's'}.`;
    }
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    window._rid = undefined;
    msg.className = 'msg ok'; msg.textContent = text + ' Browser storage cleared.';
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// ---------- Terms gate (shown until accepted) ----------
const TERMS_VERSION = '2026-11-03';
const GATE_TEXT = {
  en: {
    title: 'Before you start: Terms of use',
    intro: 'Please read this summary of the Terms of use. You need to accept them before you can use the app.',
    items: [
      ['Free and non-commercial.', 'Real Jobs Finder is a free tool. It is not a recruiter, an employer or a job board, and it does not handle applications.'],
      ['Jobs come from employers.', "Listings are taken from each employer's own website and official job board. They can change or close at any time, so always confirm details on the employer's site before applying."],
      ['Flags are signals, not verdicts.', '"Be careful" and "Warning" labels come from automated checks. A real company can be flagged by mistake and a fake one can be missed. A flag is not a finding that a company did anything wrong.'],
      ['Ratings are opinions.', "Only rate companies whose hiring process you actually took part in, once per company. Keep comments honest and respectful, and don't include names or personal details."],
      ['You send the notes.', 'Notes to employers open in your own email app. You decide whether to send them and you are responsible for what you send.'],
      ['Your data, your choice.', 'No accounts or tracking. Your ratings use an anonymous ID kept in this browser. You can permanently delete them at any time with "Delete all my data".'],
      ['Never pay for a job.', 'Real employers do not charge candidates for training, equipment or "processing". If anyone asks, stop and report it.'],
      ['Provided as is.', 'The app is provided "as is" and "as available", without warranties of any kind. To the extent the law allows, its developer is not liable for any loss arising from its use.'],
    ],
    fullTerms: 'Read the full Terms of use', privacy: 'Privacy & security',
    accept: 'I have read and accept the Terms of use and the Privacy & security notice',
    decline: 'Decline', continue: 'Accept and continue',
    declined: "You need to accept the Terms of use to use the app. You can read the full terms using the links above.",
  },
  es: {
    title: 'Antes de empezar: Términos de uso',
    intro: 'Lee este resumen de los Términos de uso. Debes aceptarlos antes de usar la aplicación.',
    items: [
      ['Gratuita y sin fines comerciales.', 'Real Jobs Finder es una herramienta gratuita. No es un reclutador, un empleador ni una bolsa de trabajo, y no gestiona postulaciones.'],
      ['Las ofertas vienen de los empleadores.', 'Las ofertas se toman del sitio web y del portal de empleo oficial de cada empresa. Pueden cambiar o cerrarse en cualquier momento; confirma siempre los detalles en el sitio del empleador antes de postularte.'],
      ['Las alertas son señales, no veredictos.', 'Las etiquetas "Ten cuidado" y "Advertencia" provienen de revisiones automáticas. Una empresa real puede marcarse por error y una falsa puede pasar desapercibida. Una alerta no significa que la empresa haya hecho algo indebido.'],
      ['Las calificaciones son opiniones.', 'Califica solo empresas en cuyo proceso de selección participaste, una vez por empresa. Mantén tus comentarios honestos y respetuosos, sin nombres ni datos personales.'],
      ['Tú envías los mensajes.', 'Los mensajes a los empleadores se abren en tu propio correo. Tú decides si enviarlos y eres responsable de lo que envías.'],
      ['Tus datos, tu decisión.', 'Sin cuentas ni rastreo. Tus calificaciones usan un identificador anónimo guardado en este navegador. Puedes borrarlas permanentemente cuando quieras con "Borrar todos mis datos".'],
      ['Nunca pagues por un empleo.', 'Los empleadores reales no cobran a los candidatos por capacitación, equipo ni "trámites". Si alguien te lo pide, detente y denúncialo.'],
      ['Se ofrece tal cual.', 'La aplicación se ofrece "tal cual" y "según disponibilidad", sin garantías de ningún tipo. En la medida en que la ley lo permita, su desarrolladora no es responsable de ninguna pérdida derivada de su uso.'],
    ],
    fullTerms: 'Leer los Términos de uso completos', privacy: 'Privacidad y seguridad',
    accept: 'He leído y acepto los Términos de uso y el aviso de Privacidad y seguridad',
    decline: 'Rechazar', continue: 'Aceptar y continuar',
    declined: 'Debes aceptar los Términos de uso para usar la aplicación. Puedes leerlos completos con los enlaces de arriba.',
  },
};

function termsAccepted() {
  try { return localStorage.getItem('rjf-terms') === TERMS_VERSION; } catch { return !!window._termsOk; }
}

function setGateLang(lang) {
  const t = GATE_TEXT[lang];
  document.documentElement.lang = lang;
  document.querySelectorAll('#dlg-terms [data-i18n]').forEach((el) => { el.textContent = t[el.dataset.i18n]; });
  $('#gateList').innerHTML = t.items.map(([h, b]) => `<li><strong>${esc(h)}</strong> ${esc(b)}</li>`).join('');
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  if ($('#gateMsg').textContent) $('#gateMsg').textContent = t.declined;
  try { localStorage.setItem('rjf-lang', lang); } catch { /* ignore */ }
}

(function initGate() {
  const dlg = $('#dlg-terms');
  let lang = 'en';
  try { lang = localStorage.getItem('rjf-lang') || ((navigator.language || '').startsWith('es') ? 'es' : 'en'); } catch { /* ignore */ }
  setGateLang(lang);
  document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => setGateLang(b.dataset.lang)));
  $('#gateCheck').addEventListener('change', (e) => { $('#gateOk').disabled = !e.target.checked; $('#gateMsg').textContent = ''; });
  $('#gateDecline').addEventListener('click', () => { $('#gateMsg').textContent = GATE_TEXT[document.documentElement.lang === 'es' ? 'es' : 'en'].declined; });
  $('#gateOk').addEventListener('click', () => {
    try { localStorage.setItem('rjf-terms', TERMS_VERSION); } catch { window._termsOk = true; }
    dlg.close();
    document.documentElement.lang = 'en'; // the rest of the app is in English for now
  });
  dlg.addEventListener('cancel', (e) => { if (!termsAccepted()) e.preventDefault(); }); // Esc can't skip it
  if (!termsAccepted()) { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); dlg.showModal(); }
})();
