// Offline tests: a local fake company website + fake Greenhouse API.
process.env.ALLOW_PRIVATE_SCAN = '1';
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');

let base;
const fixture = http.createServer((req, res) => {
  const u = req.url;
  const html = (b) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(b); };
  if (u === '/') return html('<title>Acme Corp | Home</title><a href="/careers">Careers</a>');
  if (u === '/careers') return html('<h1>Join us</h1><a href="https://boards.greenhouse.io/acmecorp">Open roles</a> Questions? <a href="mailto:careers@127.0.0.1">email</a>');
  if (u.startsWith('/domain/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: new Date(Date.now() - 40 * 864e5).toISOString() }] })); }
  if (u === '/jobs') return html(`<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'JobPosting', title: 'Warehouse Lead', datePosted: '2026-10-20', url: '/jobs/42',
        jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } }, description: '<p>Lead the team</p>' },
      { '@type': 'JobPosting', title: 'Expired Role', validThrough: '2020-01-01' },
    ] })}</script>`);
  if (u.startsWith('/v1/boards/acmecorp/jobs')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jobs: [
      { id: 1, title: 'Remote Support Engineer', location: { name: 'Remote - US' }, departments: [{ name: 'Support' }],
        first_published: new Date(Date.now() - 5 * 864e5).toISOString(), absolute_url: 'https://acme.example/jobs/1', content: '&lt;p&gt;Help customers&lt;/p&gt;' },
      { id: 777001, title: 'Senior Accountant', location: { name: 'Denver, CO' },
        first_published: new Date(Date.now() - 200 * 864e5).toISOString(), absolute_url: 'https://boards.greenhouse.io/acmecorp/jobs/777001' },
    ] }));
  }
  res.writeHead(404); res.end();
});

test.before(() => new Promise((r) => fixture.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${fixture.address().port}`;
  process.env.GREENHOUSE_BASE = base;
  process.env.RDAP_BASE = base;
  r();
})));
test.after(() => fixture.close());

test('scan finds the Greenhouse board and on-page JobPostings from the company site', async () => {
  const { scanCompany } = require('../lib/scan');
  const r = await scanCompany(base);
  assert.equal(r.name, 'Acme Corp');
  assert.ok(r.boards.some((b) => b.ats === 'greenhouse' && b.slug === 'acmecorp'), JSON.stringify(r.boards));
  assert.ok(r.boards.some((b) => b.ats === 'site' && b.url.endsWith('/jobs')), JSON.stringify(r.boards));
});

test('contact finder keeps only the company domain and prefers recruiting inboxes', () => {
  const { findContacts } = require('../lib/scan');
  const html = '<a href="mailto:hello@acme.com">hi</a> privacy@acme.com <a href="mailto:jobs@acme.com">jobs</a> scam@gmail.com talent@eu.acme.com logo@2x.png';
  assert.deepEqual(findContacts(html, 'acme.com'), ['jobs@acme.com', 'talent@eu.acme.com', 'hello@acme.com']);
});

test('stale report flags posts open > 90 days and drafts a warm note with CSAT', async () => {
  const { fetchBoard } = require('../lib/sources');
  const { staleReport } = require('../lib/stale');
  const company = { name: 'Acme', domain: '127.0.0.1', boards: [{ ats: 'greenhouse', slug: 'acmecorp' }], contacts: ['careers@127.0.0.1'] };
  const jobs = await fetchBoard(company, company.boards[0]);
  const csat = { count: 4, csat: 25, respondedPct: 50, ghostedPct: 75 };
  const [r] = staleReport([company], jobs, 90, Date.now(), () => csat);
  assert.equal(r.staleCount, 1);
  assert.equal(r.staleJobs[0].title, 'Senior Accountant');
  assert.ok(r.staleJobs[0].daysOpen >= 199);
  assert.equal(r.canNudge, true);
  assert.match(r.note.body, /more than 90 days/);
  assert.match(r.note.body, /25% were satisfied/);
  assert.match(r.note.body, /75% said they stopped hearing/);
  const [again] = staleReport([{ ...company, nudges: [{ at: new Date().toISOString() }] }], jobs, 90);
  assert.equal(again.canNudge, false, 'no repeat note within 30 days');
});

test('company check flags a brand-new domain and reports stale share', async () => {
  const { checkCompany } = require('../lib/check');
  const r = await checkCompany(base);
  assert.equal(r.verdict, 'warning'); // fixture domain "registered" 40 days ago
  assert.ok(r.flags.some((f) => f.level === 'high' && /registered only 40 days ago/.test(f.text)), JSON.stringify(r.flags));
  assert.ok(r.flags.some((f) => /open more than 90 days/.test(f.text)));
  assert.equal(r.jobCount, 3);
});

test('job link check confirms a live posting and flags one that is not listed', async () => {
  const { checkJobLink } = require('../lib/check');
  const known = [{ name: 'Acme', domain: 'acme.example', boards: [{ ats: 'greenhouse', slug: 'acmecorp' }] }];
  const ok = await checkJobLink('https://boards.greenhouse.io/acmecorp/jobs/777001', known);
  assert.equal(ok.job.title, 'Senior Accountant');
  assert.ok(ok.flags.some((f) => /Confirmed/.test(f.text)));
  const bad = await checkJobLink('https://boards.greenhouse.io/acmecorp/jobs/999999', known);
  assert.equal(bad.verdict, 'warning');
  assert.ok(bad.flags.some((f) => /not on Acme's official listings/.test(f.text)));
});

test('CSAT: one rating per person, score shown after 3 ratings', () => {
  const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rjf-')), 'r.json');
  const store = require('../lib/ratings').createStore(file);
  store.add('acme.com', { score: 5, responded: true, ghosted: false, clientId: 'user-aaaa1' });
  assert.equal(store.summary('acme.com').csat, null);
  store.add('acme.com', { score: 2, responded: true, ghosted: true, comment: 'Never heard back after interview', clientId: 'user-bbbb2' });
  store.add('acme.com', { score: 4, clientId: 'user-cccc3' });
  store.add('acme.com', { score: 1, clientId: 'user-cccc3' }); // replaces previous
  const s = store.summary('acme.com');
  assert.equal(s.count, 3);
  assert.equal(s.csat, 33);
  assert.equal(s.ghostedPct, 50);
  assert.equal(s.recent[0].comment, 'Never heard back after interview');
  assert.throws(() => store.add('acme.com', { score: 9, clientId: 'user-dddd4' }), /1 to 5/);
});

test('fetchers read the board and the careers page, dropping expired postings', async () => {
  const { fetchBoard } = require('../lib/sources');
  const company = { name: 'Acme', domain: '127.0.0.1', verified: true };
  const gh = await fetchBoard(company, { ats: 'greenhouse', slug: 'acmecorp' });
  assert.equal(gh.length, 2);
  assert.equal(gh[0].remote, true);
  assert.equal(gh[0].snippet, 'Help customers');
  const site = await fetchBoard(company, { ats: 'site', url: base + '/jobs' });
  assert.deepEqual(site.map((j) => j.title), ['Warehouse Lead']);
  assert.equal(site[0].location, 'Austin, TX');
  assert.equal(site[0].url, base + '/jobs/42');
});

test('scanner rejects private addresses and non-existent domains', async () => {
  delete process.env.ALLOW_PRIVATE_SCAN;
  const { scanCompany } = require('../lib/scan');
  await assert.rejects(scanCompany('http://127.0.0.1'), /Private/);
  await assert.rejects(scanCompany('this-company-does-not-exist-zz9.example'), /not found|Could not look up|offline/);
  process.env.ALLOW_PRIVATE_SCAN = '1';
});

test('filters by keyword, remote and location', () => {
  const { filterJobs } = require('../server');
  const jobs = [
    { title: 'Nurse', department: '', company: 'A', snippet: '', location: 'Boston, MA', remote: false, postedAt: new Date().toISOString() },
    { title: 'Python Developer', department: '', company: 'B', snippet: '', location: 'Remote', remote: true, postedAt: new Date().toISOString() },
  ];
  assert.equal(filterJobs(jobs, new URLSearchParams('q=python')).length, 1);
  assert.equal(filterJobs(jobs, new URLSearchParams('remote=1'))[0].title, 'Python Developer');
  assert.equal(filterJobs(jobs, new URLSearchParams('location=boston'))[0].title, 'Nurse');
});
