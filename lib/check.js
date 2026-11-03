// "Is this real?" checks for a company website or a specific job link.
// Each check produces a verdict plus plain-language flags that the app shows
// to anyone who searches for that company later.

const { scanCompany, findBoards, normalizeSite } = require('./scan');
const { fetchBoard, UA } = require('./sources');
const { daysOpen } = require('./stale');

const RDAP_BASE = process.env.RDAP_BASE || 'https://rdap.org';
const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com)$/i;

const SEVERITY = { high: 3, medium: 2, low: 1, info: 0 };

// Registration date of a domain, via the public RDAP registry service.
async function domainAge(domain) {
  try {
    const root = domain.split('.').slice(-2).join('.');
    const res = await fetch(`${RDAP_BASE}/domain/${encodeURIComponent(root)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const reg = (data.events || []).find((e) => e.eventAction === 'registration');
    if (!reg) return null;
    return { registeredAt: reg.eventDate, days: Math.floor((Date.now() - Date.parse(reg.eventDate)) / 864e5) };
  } catch {
    return null;
  }
}

function verdictFrom(flags) {
  const worst = Math.max(0, ...flags.map((f) => SEVERITY[f.level] ?? 0));
  return worst >= 3 ? 'warning' : worst === 2 ? 'caution' : 'verified';
}

async function loadJobs(company) {
  const results = await Promise.allSettled(company.boards.map((b) => fetchBoard(company, b)));
  return {
    jobs: results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
    errors: results.filter((r) => r.status === 'rejected').map((r) => r.reason.message),
  };
}

/** Check a company by its website. */
async function checkCompany(input, { staleDays = 90 } = {}) {
  const flags = [];
  let site;
  try {
    site = normalizeSite(input);
  } catch (e) {
    return { verdict: 'warning', domain: String(input), name: String(input), flags: [{ level: 'high', text: e.message }], checkedAt: new Date().toISOString() };
  }
  const domain = site.hostname.replace(/^www\./, '');
  const result = { domain, name: domain, checkedAt: new Date().toISOString(), jobCount: 0, staleCount: 0, boards: [] };

  const age = await domainAge(domain);
  if (age) {
    result.domainRegisteredAt = age.registeredAt;
    if (age.days < 180) flags.push({ level: 'high', text: `The website domain was registered only ${age.days} days ago. Brand-new domains are a common sign of fake employers.` });
    else if (age.days < 365) flags.push({ level: 'medium', text: `The website domain is less than a year old (registered ${age.days} days ago).` });
  }

  let scan;
  try {
    scan = await scanCompany(input);
  } catch (e) {
    // A domain that doesn't exist is a strong red flag; a site that is down may be temporary.
    flags.push({ level: /not found|Private|valid|public website/i.test(e.message) ? 'high' : 'medium', text: `Company website check failed: ${e.message}` });
    return { ...result, verdict: verdictFrom(flags), flags };
  }
  Object.assign(result, { name: scan.name, boards: scan.boards, contacts: scan.contacts, careersUrl: scan.careersUrl });

  if (!scan.https) flags.push({ level: 'low', text: 'The website does not use a secure (https) connection.' });

  if (!scan.boards.length) {
    flags.push({ level: 'medium', text: `No job listings were found on ${domain}. If someone offers you a job "at" this company, ask them where it is posted on the company's own website.` });
    return { ...result, verdict: verdictFrom(flags), flags };
  }

  const { jobs, errors } = await loadJobs({ name: scan.name, domain, verified: true, boards: scan.boards });
  result.jobCount = jobs.length;
  if (!jobs.length && errors.length) flags.push({ level: 'medium', text: `The company's job board could not be read: ${errors.join('; ')}` });
  else if (!jobs.length) flags.push({ level: 'medium', text: `The company's official job board currently has no open roles. Offers claiming this company is hiring right now can't be confirmed.` });

  const stale = jobs.filter((j) => (daysOpen(j) ?? 0) > staleDays);
  result.staleCount = stale.length;
  if (stale.length) {
    const share = Math.round((stale.length / jobs.length) * 100);
    flags.push({
      level: share >= 50 ? 'medium' : 'low',
      text: `${stale.length} of ${jobs.length} posts (${share}%) have been open more than ${staleDays} days and may already be filled.`,
    });
  }
  if (jobs.length) flags.push({ level: 'info', text: `${jobs.length} live job${jobs.length === 1 ? '' : 's'} confirmed on the company's own ${scan.boards.some((b) => b.ats === 'site') ? 'website' : 'official job board'}.` });

  return { ...result, verdict: verdictFrom(flags), flags };
}

const normUrl = (u) => {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
};

/**
 * Check a specific job link someone found or was sent.
 * `knownCompanies` are verified companies (with boards) used to identify who owns an ATS board.
 */
async function checkJobLink(link, knownCompanies = [], opts = {}) {
  let u;
  try { u = new URL(link); } catch { return { verdict: 'warning', flags: [{ level: 'high', text: 'That is not a valid web link.' }], checkedAt: new Date().toISOString() }; }
  if (!/^https?:$/.test(u.protocol)) return { verdict: 'warning', flags: [{ level: 'high', text: 'Only web links (http/https) can be checked.' }], checkedAt: new Date().toISOString() };

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const flags = [];
  let company;
  let companyCheck = null;

  if (ATS_HOSTS.test(host)) {
    const [board] = findBoards(u.href);
    company = board && knownCompanies.find((c) => c.boards?.some((b) => b.ats === board.ats && b.slug.toLowerCase() === board.slug.toLowerCase()));
    if (!company && board) {
      flags.push({ level: 'medium', text: `This is a ${board.ats} job board ("${board.slug}"), but we haven't confirmed which company website links to it. Check the company's website and make sure its careers page links here.` });
      company = { name: board.slug, domain: host, boards: [board] };
    } else if (!board) {
      flags.push({ level: 'medium', text: 'This looks like a job-board link, but we could not identify the company board.' });
    }
  } else {
    company = knownCompanies.find((c) => host === c.domain || host.endsWith('.' + c.domain));
    if (!company) {
      companyCheck = await checkCompany(u.origin, opts);
      if (companyCheck.boards?.length) company = { name: companyCheck.name, domain: companyCheck.domain, boards: companyCheck.boards };
      flags.push(...companyCheck.flags.filter((f) => f.level !== 'info'));
    }
  }

  const result = { link: u.href, company: company ? { name: company.name, domain: company.domain } : null, checkedAt: new Date().toISOString() };
  if (company?.boards?.length) {
    const { jobs } = await loadJobs(company);
    const target = normUrl(u.href);
    const match = jobs.find((j) => normUrl(j.url) === target || (String(j.id).split(':').pop().length > 3 && u.href.includes(String(j.id).split(':').pop())));
    if (match) {
      result.job = { title: match.title, location: match.location, url: match.url, daysOpen: daysOpen(match) };
      const d = daysOpen(match);
      if (d !== null && d > (opts.staleDays || 90)) flags.push({ level: 'low', text: `This job has been open ${d} days and may already be filled.` });
      flags.push({ level: 'info', text: `Confirmed: "${match.title}" is a live posting on ${company.name}'s official listings.` });
    } else {
      flags.push({ level: 'high', text: `This job is not on ${company.name}'s official listings. It may be closed, or it may be fake. Apply only through the company's own careers page.` });
    }
  } else if (!flags.some((f) => f.level === 'high')) {
    flags.push({ level: 'high', text: 'We could not find this job on any official company listing.' });
  }

  return { ...result, verdict: verdictFrom(flags), flags };
}

module.exports = { checkCompany, checkJobLink, domainAge, verdictFrom };
