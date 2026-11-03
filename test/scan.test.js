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
  if (u === '/careers') return html('<h1>Join us</h1><a href="https://boards.greenhouse.io/acmecorp">Open roles</a>');
  if (u === '/jobs') return html(`<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'JobPosting', title: 'Warehouse Lead', datePosted: '2026-10-20', url: '/jobs/42',
        jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } }, description: '<p>Lead the team</p>' },
      { '@type': 'JobPosting', title: 'Expired Role', validThrough: '2020-01-01' },
    ] })}</script>`);
  if (u.startsWith('/v1/boards/acmecorp/jobs')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jobs: [{ id: 1, title: 'Remote Support Engineer', location: { name: 'Remote - US' },
      departments: [{ name: 'Support' }], first_published: '2026-10-30T00:00:00Z', absolute_url: 'https://acme.example/jobs/1', content: '&lt;p&gt;Help customers&lt;/p&gt;' }] }));
  }
  res.writeHead(404); res.end();
});

test.before(() => new Promise((r) => fixture.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${fixture.address().port}`;
  process.env.GREENHOUSE_BASE = base;
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

test('fetchers read the board and the careers page, dropping expired postings', async () => {
  const { fetchBoard } = require('../lib/sources');
  const company = { name: 'Acme', domain: '127.0.0.1', verified: true };
  const gh = await fetchBoard(company, { ats: 'greenhouse', slug: 'acmecorp' });
  assert.equal(gh.length, 1);
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
