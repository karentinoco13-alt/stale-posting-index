// Fetchers for the public job-board APIs that companies use to power their
// own careers pages. Every job returned here comes straight from the
// employer's official applicant-tracking system (ATS), not from a reposting
// site, so it is a live opening the employer itself published.

const BASES = {
  greenhouse: process.env.GREENHOUSE_BASE || 'https://boards-api.greenhouse.io',
  lever: process.env.LEVER_BASE || 'https://api.lever.co',
  ashby: process.env.ASHBY_BASE || 'https://api.ashbyhq.com',
  smartrecruiters: process.env.SMARTRECRUITERS_BASE || 'https://api.smartrecruiters.com',
  workable: process.env.WORKABLE_BASE || 'https://apply.workable.com',
};

const UA = 'RealJobsFinder/1.0 (+https://github.com/)';

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const stripHtml = (s = '') =>
  s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();

const decodeEntities = (s = '') =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const looksRemote = (...parts) => /\bremote\b|work from home|anywhere/i.test(parts.filter(Boolean).join(' '));

function job(company, board, fields) {
  const j = {
    id: `${board.ats}:${board.slug || board.url}:${fields.id}`,
    company: company.name,
    companyDomain: company.domain,
    verified: !!company.verified,
    source: board.ats,
    title: fields.title || 'Untitled role',
    location: fields.location || 'Not specified',
    department: fields.department || '',
    employmentType: fields.employmentType || '',
    remote: fields.remote ?? looksRemote(fields.location, fields.title, fields.workplace),
    postedAt: fields.postedAt || null,
    url: fields.url,
    snippet: (fields.snippet || '').slice(0, 280),
  };
  return j;
}

const fetchers = {
  // Jobs listed directly on the company's own careers page (schema.org JobPosting).
  async site(company, board) {
    const { fetchPage, findJsonLdJobs } = require('./scan'); // lazy: avoids circular import
    const host = new URL(board.url).hostname.replace(/^www\./, '');
    if (!host.endsWith(company.domain)) throw new Error('Careers page is not on the company domain');
    const page = await fetchPage(board.url);
    if (!page.html) throw new Error(`HTTP ${page.status} from ${host}`);
    return findJsonLdJobs(page.html, page.url).map((f) => job(company, board, f));
  },

  async greenhouse(company, board) {
    const data = await getJSON(`${BASES.greenhouse}/v1/boards/${encodeURIComponent(board.slug)}/jobs?content=true`);
    return (data.jobs || []).map((p) =>
      job(company, board, {
        id: p.id,
        title: p.title,
        location: p.location?.name,
        department: p.departments?.map((d) => d.name).join(', '),
        postedAt: p.first_published || p.updated_at,
        url: p.absolute_url,
        snippet: stripHtml(decodeEntities(p.content || '')),
      }));
  },

  async lever(company, board) {
    const data = await getJSON(`${BASES.lever}/v0/postings/${encodeURIComponent(board.slug)}?mode=json`);
    return (data || []).map((p) =>
      job(company, board, {
        id: p.id,
        title: p.text,
        location: p.categories?.location || p.categories?.allLocations?.join(', '),
        department: p.categories?.team || p.categories?.department,
        employmentType: p.categories?.commitment,
        workplace: p.workplaceType,
        remote: p.workplaceType === 'remote' || looksRemote(p.categories?.location, p.text),
        postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        url: p.hostedUrl,
        snippet: p.descriptionPlain || stripHtml(p.description),
      }));
  },

  async ashby(company, board) {
    const data = await getJSON(`${BASES.ashby}/posting-api/job-board/${encodeURIComponent(board.slug)}`);
    return (data.jobs || []).filter((p) => p.isListed !== false).map((p) =>
      job(company, board, {
        id: p.id,
        title: p.title,
        location: [p.location, ...(p.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(' · '),
        department: p.department || p.team,
        employmentType: p.employmentType,
        remote: p.isRemote || looksRemote(p.location, p.title),
        postedAt: p.publishedAt,
        url: p.jobUrl || p.applyUrl,
        snippet: p.descriptionPlain || stripHtml(p.descriptionHtml),
      }));
  },

  async smartrecruiters(company, board) {
    const data = await getJSON(`${BASES.smartrecruiters}/v1/companies/${encodeURIComponent(board.slug)}/postings?limit=100`);
    return (data.content || []).map((p) =>
      job(company, board, {
        id: p.id,
        title: p.name,
        location: [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(', '),
        department: p.department?.label,
        employmentType: p.typeOfEmployment?.label,
        remote: p.location?.remote || looksRemote(p.location?.city, p.name),
        postedAt: p.releasedDate,
        url: `https://jobs.smartrecruiters.com/${board.slug}/${p.id}`,
      }));
  },

  async workable(company, board) {
    const data = await getJSON(`${BASES.workable}/api/v3/accounts/${encodeURIComponent(board.slug)}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }),
    });
    return (data.results || []).map((p) =>
      job(company, board, {
        id: p.shortcode,
        title: p.title,
        location: [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(', '),
        department: Array.isArray(p.department) ? p.department.join(', ') : p.department,
        employmentType: p.type,
        remote: p.remote || p.workplace === 'remote',
        postedAt: p.published,
        url: `https://apply.workable.com/${board.slug}/j/${p.shortcode}/`,
      }));
  },
};

async function fetchBoard(company, board) {
  const fn = fetchers[board.ats];
  if (!fn) throw new Error(`Unsupported job board type: ${board.ats}`);
  return fn(company, board);
}

module.exports = { fetchBoard, SUPPORTED: Object.keys(fetchers), UA };
