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
    const old = j.postedAt && Date.now() - Date.parse(j.postedAt) > 60 * 864e5;
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
        ${old ? '<span class="badge warn" title="Older postings may already be filled">Posted 60+ days ago</span>' : ''}
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
