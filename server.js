// Real Jobs Finder — a tiny, dependency-free Node server.
// Run:  node server.js   then open http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fetchBoard } = require('./lib/sources');
const { scanCompany } = require('./lib/scan');
const { staleReport } = require('./lib/stale');
const { checkCompany, checkJobLink } = require('./lib/check');
const ratingsStore = require('./lib/ratings');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.COMPANIES_FILE || path.join(__dirname, 'data', 'companies.json');
const PUBLIC = path.join(__dirname, 'public');
const CACHE_MS = 30 * 60 * 1000;
const TERMS_VERSION = '2026-11-03'; // keep in sync with public/app.js; bump to ask everyone to re-accept

// ---------- company list (persisted to data/companies.json) ----------
function loadCompanies() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function saveCompanies(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
let companies = loadCompanies();

const DATA_DIR = path.dirname(DATA_FILE);
const ratings = ratingsStore.createStore(process.env.RATINGS_FILE || path.join(DATA_DIR, 'ratings.json'));

// Results of "Is this real?" checks, saved so anyone searching the company later sees the flags.
const CHECKS_FILE = process.env.CHECKS_FILE || path.join(DATA_DIR, 'checks.json');
let checks = {};
try { checks = JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf8')); } catch { /* none yet */ }
function saveCheck(domain, entry) {
  checks[domain] = { ...(checks[domain] || {}), ...entry };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CHECKS_FILE, JSON.stringify(checks, null, 2));
}

// Find a company by name or domain among saved companies and past checks.
function findByName(q) {
  const n = q.toLowerCase().trim();
  if (!n) return null;
  const pool = [
    ...companies.filter((c) => c.domain).map((c) => ({ name: c.name, domain: c.domain })),
    ...Object.values(checks).map((c) => ({ name: c.name, domain: c.domain })),
  ];
  return pool.find((c) => c.name?.toLowerCase() === n || c.domain === n || c.domain.split('.')[0] === n)
    || pool.find((c) => c.name?.toLowerCase().includes(n) && n.length >= 3) || null;
}

function companyProfile(domain) {
  const c = checks[domain] || null;
  const known = companies.find((x) => x.domain === domain);
  return {
    domain,
    name: c?.name || known?.name || domain,
    check: c,
    inList: !!known?.boards,
    csat: ratings.summary(domain),
    lastNudge: known?.nudges?.at(-1) || null,
  };
}

// Simple per-IP rate limit for write endpoints.
const hits = new Map();
function rateLimited(req, max = 20) {
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

// Entries that are just { website } have not been scanned yet. Scan the real
// company website and keep only job boards that the site itself links to.
const scanState = new Map(); // website -> 'scanning' | error message

async function verifyPending() {
  for (const c of companies.filter((x) => !x.boards)) {
    scanState.set(c.website, 'scanning');
    try {
      const scan = await scanCompany(c.website);
      if (!scan.boards.length) throw new Error('No careers board or job listings found on the website');
      Object.assign(c, { name: c.name || scan.name, domain: scan.domain, verified: true, boards: scan.boards, contacts: scan.contacts, careersUrl: scan.careersUrl, addedAt: new Date().toISOString() });
      scanState.delete(c.website);
      saveCompanies(companies);
      console.log(`Verified ${c.name}: ${scan.boards.map((b) => b.ats).join(', ')}`);
    } catch (e) {
      scanState.set(c.website, e.message);
      console.log(`Could not verify ${c.website}: ${e.message}`);
    }
  }
}

// ---------- job cache ----------
const cache = new Map(); // key company.domain -> { at, jobs, error }

async function jobsFor(company, force = false) {
  const hit = cache.get(company.domain);
  if (hit && !force && Date.now() - hit.at < CACHE_MS) return hit;
  const results = await Promise.allSettled(company.boards.map((b) => fetchBoard(company, b)));
  const jobs = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  const entry = { at: Date.now(), jobs, error: jobs.length === 0 && errors.length ? errors.join('; ') : null };
  cache.set(company.domain, entry);
  return entry;
}

async function allJobs(force) {
  if (force && companies.some((c) => !c.boards)) verifyPending(); // retry failed scans in background
  const ready = companies.filter((c) => c.boards);
  const pending = companies.filter((c) => !c.boards).map((c) => {
    const st = scanState.get(c.website);
    return { name: c.website, domain: c.website, verified: false, boards: [], jobCount: 0,
      error: st === 'scanning' || st === undefined ? null : st, pending: st === 'scanning' || st === undefined };
  });
  const out = await Promise.all(ready.map(async (c) => ({ c, r: await jobsFor(c, force) })));
  return {
    jobs: out.flatMap((x) => x.r.jobs),
    status: pending.concat(out.map(({ c, r }) => ({
      name: c.name, domain: c.domain, verified: !!c.verified, boards: c.boards,
      jobCount: r.jobs.length, error: r.error, fetchedAt: new Date(r.at).toISOString(),
    }))),
  };
}

// ---------- filtering ----------
function filterJobs(jobs, q) {
  const words = (q.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const loc = (q.get('location') || '').toLowerCase().trim();
  const remoteOnly = q.get('remote') === '1';
  const days = Number(q.get('days')) || 0;
  const company = (q.get('company') || '').toLowerCase();
  const cutoff = days ? Date.now() - days * 864e5 : 0;

  return jobs
    .filter((j) => {
      const hay = `${j.title} ${j.department} ${j.company} ${j.snippet}`.toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) return false;
      if (loc && !j.location.toLowerCase().includes(loc)) return false;
      if (remoteOnly && !j.remote) return false;
      if (company && j.companyDomain !== company) return false;
      if (cutoff && j.postedAt && Date.parse(j.postedAt) < cutoff) return false;
      return true;
    })
    .sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
}

// ---------- http helpers ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      const { jobs, status } = await allJobs(url.searchParams.get('refresh') === '1');
      const nudged = new Map(companies.filter((c) => c.nudges?.length).map((c) => [c.domain, c.nudges.at(-1).at]));
      const filtered = filterJobs(jobs, url.searchParams).map((j) => (nudged.has(j.companyDomain) ? { ...j, companyNudgedAt: nudged.get(j.companyDomain) } : j));
      const named = findByName(url.searchParams.get('q') || '') || (url.searchParams.get('company') && { domain: url.searchParams.get('company') });
      const alert = named ? companyProfile(named.domain) : null;
      return send(res, 200, { total: filtered.length, jobs: filtered.slice(0, 500), companies: status.map((c) => ({ ...c, csat: c.domain && ratings.summary(c.domain) })), alert });
    }

    // Employer review: companies with postings open longer than `days` (default 90).
    if (url.pathname === '/api/stale' && req.method === 'GET') {
      const days = Math.max(1, Number(url.searchParams.get('days')) || 90);
      const { jobs } = await allJobs(false);
      const report = staleReport(companies.filter((c) => c.boards), jobs, days, Date.now(), (d) => ratings.summary(d));
      return send(res, 200, { days, companies: report, staleJobs: report.reduce((n, c) => n + c.staleCount, 0) });
    }

    // Record that a note was sent to a company (the app never sends email itself).
    const nudge = url.pathname.match(/^\/api\/companies\/([^/]+)\/nudge$/);
    if (nudge && req.method === 'POST') {
      const c = companies.find((x) => x.domain === decodeURIComponent(nudge[1]));
      if (!c) return send(res, 404, { error: 'Company not found' });
      const { jobIds = [], to = '' } = await readBody(req);
      c.nudges = (c.nudges || []).concat({ at: new Date().toISOString(), jobIds: jobIds.slice(0, 200), to: String(to).slice(0, 200) });
      saveCompanies(companies);
      return send(res, 200, { ok: true, lastNudge: c.nudges.at(-1) });
    }

    // "Is this real?" check: a company website, a company name, or a job link.
    if (url.pathname === '/api/check' && req.method === 'POST') {
      if (rateLimited(req, 60)) return send(res, 429, { error: 'Too many checks. Try again in a little while.' });
      const query = String((await readBody(req)).query || '').trim();
      if (!query) return send(res, 400, { error: 'Enter a company name, website or job link' });

      const isLink = /^https?:\/\//i.test(query) && new URL(query).pathname.length > 1;
      if (isLink) {
        const result = await checkJobLink(query, companies.filter((c) => c.boards));
        if (result.company?.domain) {
          const d = result.company.domain;
          const prev = checks[d]?.linkFlags || [];
          const flagged = result.verdict !== 'verified' ? [{ link: result.link, verdict: result.verdict, flags: result.flags.filter((f) => f.level !== 'info'), at: result.checkedAt }] : [];
          saveCheck(d, { name: checks[d]?.name || result.company.name, domain: d, linkFlags: prev.filter((x) => x.link !== result.link).concat(flagged).slice(-20) });
          result.profile = companyProfile(d);
        }
        return send(res, 200, { type: 'job', ...result });
      }

      let target = query;
      if (!query.includes('.')) {
        const found = findByName(query);
        if (!found) return send(res, 404, { error: `We haven't checked "${query}" yet. Enter its website (e.g. ${query.toLowerCase().replace(/\s+/g, '')}.com) so we can scan it.` });
        target = found.domain;
      }
      const result = await checkCompany(target);
      saveCheck(result.domain, { name: result.name, domain: result.domain, verdict: result.verdict, flags: result.flags, jobCount: result.jobCount, staleCount: result.staleCount, checkedAt: result.checkedAt, domainRegisteredAt: result.domainRegisteredAt });
      return send(res, 200, { type: 'company', ...result, profile: companyProfile(result.domain) });
    }

    // Company profile: last check + recruiting CSAT.
    const prof = url.pathname.match(/^\/api\/company\/([^/]+)$/);
    if (prof && req.method === 'GET') return send(res, 200, companyProfile(decodeURIComponent(prof[1]).toLowerCase()));

    // Rate a company's recruiting team.
    const rate = url.pathname.match(/^\/api\/company\/([^/]+)\/ratings$/);
    if (rate && req.method === 'POST') {
      if (rateLimited(req, 20)) return send(res, 429, { error: 'Too many ratings from this connection. Try again later.' });
      const domain = decodeURIComponent(rate[1]).toLowerCase();
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return send(res, 400, { error: 'Invalid company' });
      if (!checks[domain] && !companies.some((c) => c.domain === domain)) return send(res, 404, { error: 'Check the company first, then rate it' });
      const body = await readBody(req);
      if (body.termsVersion !== TERMS_VERSION) return send(res, 403, { error: 'Please accept the Terms of use (reload the page) before rating.' });
      return send(res, 200, ratings.add(domain, body));
    }

    // Feedback form (saved to data/feedback.json for the app owner to read).
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      if (rateLimited(req, 10)) return send(res, 429, { error: 'Too many messages. Try again later.' });
      const b = await readBody(req);
      const message = String(b.message || '').trim().slice(0, 2000);
      if (message.length < 3) return send(res, 400, { error: 'Please write a message' });
      const file = process.env.FEEDBACK_FILE || path.join(DATA_DIR, 'feedback.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first one */ }
      list.push({ at: new Date().toISOString(), topic: String(b.topic || 'general').slice(0, 40), message, replyTo: String(b.replyTo || '').trim().slice(0, 200), clientId: String(b.clientId || '').slice(0, 64) });
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
      return send(res, 201, { ok: true });
    }

    // "Delete all my data": ratings and feedback tied to this browser's anonymous id.
    if (url.pathname === '/api/my-data' && req.method === 'DELETE') {
      const { clientId } = await readBody(req);
      if (!/^[a-z0-9-]{8,64}$/i.test(String(clientId || ''))) return send(res, 400, { error: 'Missing id' });
      const ratingsRemoved = ratings.removeByClient(clientId);
      const file = process.env.FEEDBACK_FILE || path.join(DATA_DIR, 'feedback.json');
      let feedbackRemoved = 0;
      try {
        const list = JSON.parse(fs.readFileSync(file, 'utf8'));
        const kept = list.filter((f) => f.clientId !== clientId);
        feedbackRemoved = list.length - kept.length;
        if (feedbackRemoved) fs.writeFileSync(file, JSON.stringify(kept, null, 2));
      } catch { /* no feedback file */ }
      return send(res, 200, { ratingsRemoved, feedbackRemoved });
    }

    if (url.pathname === '/api/scan' && req.method === 'POST') {
      const { website } = await readBody(req);
      const result = await scanCompany(website);
      return send(res, 200, result);
    }

    if (url.pathname === '/api/companies' && req.method === 'POST') {
      const body = await readBody(req);
      let entry;
      if (body.website) {
        // Scan the real website and only trust boards linked from it.
        const scan = await scanCompany(body.website);
        if (!scan.boards.length) {
          return send(res, 422, { error: `No job listings found on ${scan.domain}. We checked its homepage and careers pages for an official job board or posted jobs.`, scan });
        }
        entry = { name: body.name || scan.name, domain: scan.domain, verified: true, boards: scan.boards, contacts: scan.contacts, careersUrl: scan.careersUrl, addedAt: new Date().toISOString() };
      } else {
        return send(res, 400, { error: 'Provide a website to scan' });
      }
      // Confirm the board actually returns openings before saving.
      const check = await jobsFor(entry, true);
      if (check.error) return send(res, 422, { error: `Found the job board but could not read it: ${check.error}` });
      companies = companies.filter((c) => c.domain !== entry.domain && c.website !== body.website).concat(entry);
      saveCompanies(companies);
      return send(res, 201, { company: entry, jobCount: check.jobs.length });
    }

    if (url.pathname.startsWith('/api/companies/') && req.method === 'DELETE') {
      const domain = decodeURIComponent(url.pathname.split('/').pop());
      companies = companies.filter((c) => c.domain !== domain && c.website !== domain);
      cache.delete(domain);
      saveCompanies(companies);
      return send(res, 200, { ok: true });
    }

    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // static files
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Real Jobs Finder running at http://localhost:${PORT} (${companies.length} companies)`);
    verifyPending();
  });
}
module.exports = { server, filterJobs, verifyPending };
