// Real Jobs Finder — a tiny, dependency-free Node server.
// Run:  node server.js   then open http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fetchBoard } = require('./lib/sources');
const { scanCompany } = require('./lib/scan');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.COMPANIES_FILE || path.join(__dirname, 'data', 'companies.json');
const PUBLIC = path.join(__dirname, 'public');
const CACHE_MS = 30 * 60 * 1000;

// ---------- company list (persisted to data/companies.json) ----------
function loadCompanies() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function saveCompanies(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
let companies = loadCompanies();

// Entries that are just { website } have not been scanned yet. Scan the real
// company website and keep only job boards that the site itself links to.
const scanState = new Map(); // website -> 'scanning' | error message

async function verifyPending() {
  for (const c of companies.filter((x) => !x.boards)) {
    scanState.set(c.website, 'scanning');
    try {
      const scan = await scanCompany(c.website);
      if (!scan.boards.length) throw new Error('No careers board or job listings found on the website');
      Object.assign(c, { name: c.name || scan.name, domain: scan.domain, verified: true, boards: scan.boards, addedAt: new Date().toISOString() });
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
      const filtered = filterJobs(jobs, url.searchParams);
      return send(res, 200, { total: filtered.length, jobs: filtered.slice(0, 500), companies: status });
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
        entry = { name: body.name || scan.name, domain: scan.domain, verified: true, boards: scan.boards, addedAt: new Date().toISOString() };
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
