// Scans a company's own website to find the official job board it links to.
// A board found on the company's own domain is marked "verified": the
// employer itself points applicants there, so its postings are genuine.

const dns = require('node:dns/promises');
const net = require('node:net');
const { UA } = require('./sources');

// Patterns for links/embeds to supported applicant-tracking systems.
const PATTERNS = [
  { ats: 'greenhouse', re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/gi },
  { ats: 'greenhouse', re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi },
  { ats: 'lever', re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/gi },
  { ats: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/gi },
  { ats: 'smartrecruiters', re: /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/gi },
  { ats: 'workable', re: /apply\.workable\.com\/([a-z0-9_-]+)/gi },
];

const IGNORED_SLUGS = new Set(['embed', 'api', 'v1', 'js', 'static', 'assets', 'j', 'jobs', 'careers', 'widget']);

const CAREER_PATHS = ['', '/careers', '/jobs', '/careers/', '/company/careers', '/about/careers', '/join-us', '/work-with-us'];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    (v.startsWith('::ffff:') && isPrivateIp(v.slice(7)));
}

function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a company website, e.g. example.com');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) websites are supported');
  if (!u.hostname.includes('.')) throw new Error('That does not look like a public website');
  return u;
}

// Guard against the scanner being pointed at internal network addresses.
async function assertPublicHost(hostname) {
  if (process.env.ALLOW_PRIVATE_SCAN === '1') return;
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private network addresses are not allowed');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (e) {
    // Behind a proxy, local DNS may be unavailable; the proxy resolves names.
    if (process.env.HTTPS_PROXY || process.env.https_proxy) return;
    if (e.code === 'ENOTFOUND') throw new Error(`Domain ${hostname} was not found. Check the spelling; a company without a working website may not be real`);
    throw new Error(`Could not look up ${hostname} (${e.code || e.message}). Check your internet connection`);
  }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private network addresses are not allowed');
}

async function fetchPage(url, depth = 0) {
  const u = new URL(url);
  await assertPublicHost(u.hostname);
  const res = await fetch(u, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location') && depth < 5) {
    return fetchPage(new URL(res.headers.get('location'), u).href, depth + 1);
  }
  if (!res.ok) return { url: u.href, status: res.status, html: '' };
  // Read at most ~2 MB.
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < 2_000_000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return { url: u.href, status: res.status, html: Buffer.concat(chunks).toString('utf8') };
}

function findBoards(html) {
  const found = new Map();
  for (const { ats, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) {
      const slug = decodeURIComponent(m[1]).replace(/[/?#].*$/, '');
      if (!slug || IGNORED_SLUGS.has(slug.toLowerCase())) continue;
      found.set(`${ats}:${slug.toLowerCase()}`, { ats, slug });
    }
  }
  return [...found.values()];
}

// Jobs published directly on the company's own pages using schema.org
// JobPosting structured data (the same markup Google for Jobs reads).
function findJsonLdJobs(html, pageUrl) {
  const jobs = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const type = [].concat(node['@type'] || []);
    if (type.includes('JobPosting')) jobs.push(node);
    if (node['@graph']) walk(node['@graph']);
    if (node.itemListElement) walk(node.itemListElement.map((i) => i.item || i));
  };
  while ((m = re.exec(html))) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* skip malformed block */ }
  }
  return jobs.map((j) => {
    const locs = [].concat(j.jobLocation || []).map((l) => {
      const a = l.address || {};
      return typeof a === 'string' ? a : [a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry].filter(Boolean).join(', ');
    }).filter(Boolean);
    let url = j.url || j.sameAs || pageUrl;
    try { url = new URL(url, pageUrl).href; } catch { url = pageUrl; }
    return {
      id: j.identifier?.value || j.identifier || url + '#' + (j.title || ''),
      title: j.title,
      location: locs.join(' · ') || (j.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
      employmentType: [].concat(j.employmentType || []).join(', '),
      remote: j.jobLocationType === 'TELECOMMUTE',
      postedAt: j.datePosted,
      validThrough: j.validThrough,
      url,
      snippet: String(j.description || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(),
    };
  }).filter((j) => j.title && !(j.validThrough && Date.parse(j.validThrough) < Date.now()));
}

function findCareerLinks(html, base) {
  const links = new Set();
  const re = /href=["']([^"'#]+)["'][^>]*>([^<]{0,80})/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, href, text] = m;
    if (/career|jobs|join|hiring|work.with.us|open.positions/i.test(href + ' ' + text)) {
      try {
        const u = new URL(href, base);
        if (u.hostname.endsWith(base.hostname.replace(/^www\./, ''))) links.add(u.href);
      } catch { /* ignore */ }
    }
  }
  return [...links].slice(0, 5);
}

// Hiring contact emails published on the company's own pages, preferring
// recruiting addresses (careers@, jobs@, talent@ ...).
function findContacts(html, domain) {
  const found = new Set();
  const re = /(?:mailto:)?([a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,}))/gi;
  let m;
  while ((m = re.exec(html))) {
    const email = m[1].toLowerCase().replace(/\.$/, '');
    const host = m[2].toLowerCase();
    if (!(host === domain || host.endsWith('.' + domain))) continue; // only the company's own domain
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(email) || /noreply|no-reply|donotreply|privacy|abuse|legal|security|press|sales|billing/.test(email)) continue;
    found.add(email);
  }
  const score = (e) => (/^(careers?|jobs?|talent|recruit|recruiting|recruitment|hiring|hr|people|join)/.test(e) ? 0 : 1);
  return [...found].sort((a, b) => score(a) - score(b)).slice(0, 3);
}

function guessName(html, hostname) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i);
  if (og) return og[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)/i);
  if (title) {
    const t = title[1].split(/[|\-–—:]/)[0].trim();
    if (t && t.length < 40) return t;
  }
  const base = hostname.replace(/^www\./, '').split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Scan a company website. Returns { name, domain, boards, checkedPages, https }.
 */
async function scanCompany(input) {
  const site = normalizeSite(input);
  try {
    return await scanSite(site);
  } catch (e) {
    // Some small company sites still only work over plain http.
    if (site.protocol === 'https:' && !/^https:/i.test(String(input).trim()) && /offline/.test(e.message)) {
      const plain = new URL(site.href); plain.protocol = 'http:';
      return scanSite(plain);
    }
    throw e;
  }
}

async function scanSite(site) {
  const domain = site.hostname.replace(/^www\./, '');
  const visited = [];
  const boards = new Map();
  const contacts = new Set();
  let careersUrl = null;
  let homeHtml = '';
  const queue = CAREER_PATHS.map((p) => new URL(p, site.origin).href);
  const seen = new Set();

  while (queue.length && visited.length < 10) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let page;
    try {
      page = await fetchPage(url);
    } catch (e) {
      if (visited.length === 0 && /DNS|Private/.test(e.message)) throw e;
      visited.push({ url, error: e.message });
      continue;
    }
    visited.push({ url: page.url, status: page.status });
    if (!page.html) continue;
    if (!homeHtml) homeHtml = page.html;
    for (const b of findBoards(page.html)) boards.set(`${b.ats}:${b.slug.toLowerCase()}`, b);
    if (findJsonLdJobs(page.html, page.url).length) boards.set(`site:${page.url}`, { ats: 'site', url: page.url });
    for (const e of findContacts(page.html, domain)) contacts.add(e);
    if (!careersUrl && page.status < 400 && new URL(page.url).pathname.length > 1 && /career|job|join|work/i.test(page.url)) careersUrl = page.url;
    for (const link of findCareerLinks(page.html, new URL(page.url))) if (!seen.has(link)) queue.push(link);
    if (boards.size && visited.length >= 3) break;
  }

  if (!visited.some((v) => v.status && v.status < 400)) {
    throw new Error(`Could not load ${site.origin} — the website appears to be offline`);
  }

  return {
    name: guessName(homeHtml, site.hostname),
    domain,
    https: site.protocol === 'https:',
    boards: [...boards.values()],
    contacts: [...contacts].slice(0, 3),
    careersUrl,
    checkedPages: visited,
  };
}

module.exports = { scanCompany, findContacts, findBoards, findJsonLdJobs, fetchPage, normalizeSite, isPrivateIp };
