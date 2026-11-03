# Real Jobs Finder

Find **real, current job openings**, taken straight from companies' own websites.

Most job sites are full of reposted, expired or fake listings. This app avoids that by going to the source:

1. **You give it a company website** (e.g. `stripe.com`).
2. **It scans that website**: the homepage, `/careers`, `/jobs`, and any "Careers / Join us" links it finds.
3. **It uses only what the company itself publishes:**
   - the official hiring board the site links to (**Greenhouse, Lever, Ashby, SmartRecruiters, Workable**), read through that board's public API, and
   - jobs posted directly on the company's careers pages with standard `schema.org/JobPosting` data (the same data Google Jobs reads).
4. Every job links to the company's own application page. Expired postings are dropped, and postings older than 60 days are flagged.

If the domain doesn't exist, the site is down, or the site doesn't list any jobs, the company isn't added.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer. No other installs needed.

```bash
cd job-finder
npm start
```

Then open **http://localhost:3000**.

The first time it starts, it scans the starter companies in `data/companies.json`, which takes a few seconds. Add more companies from the "Add a company" box, or list their websites in that file:

```json
[
  { "website": "stripe.com" },
  { "website": "your-favorite-company.com" }
]
```

### Behind a corporate proxy?

Start it with Node's proxy support turned on:

```bash
NODE_USE_ENV_PROXY=1 npm start
```

## Features

- Search by keyword, location, remote-only and posting date (7 / 30 / 90 days)
- Newest jobs first, with company, department, job type and a short description
- "✓ From company.com" badge on every job, showing which website it was found on
- Job lists are cached for 30 minutes; **Refresh from company sites** fetches fresh data
- Remove companies with ✕
- The scanner won't visit private/internal network addresses

## Tests

```bash
npm test
```

The tests run offline against a local fake company website and job board.

## Files

| Path | What it does |
| --- | --- |
| `server.js` | Web server + API (`/api/jobs`, `/api/companies`, `/api/scan`) |
| `lib/scan.js` | Scans a company website for its job board and on-page job postings |
| `lib/sources.js` | Reads jobs from each job-board API and from careers pages |
| `public/` | The web page (HTML/CSS/JS) |
| `data/companies.json` | Your list of companies (updated automatically) |
