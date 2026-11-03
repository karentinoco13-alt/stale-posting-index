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
      body: JSON.stringify({ score: Number(f.get('score')), stage: f.get('stage'), responded: tri('responded'), ghosted: tri('ghosted'), respectful: tri('respectful'), comment: f.get('comment'), clientId: clientId() }),
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
