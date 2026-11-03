# Real Jobs Finder

Find **real, current job openings**, taken straight from companies' own websites.

Most job sites are full of reposted, expired or fake listings. This app avoids that by going to the source:

1. **You give it a company website** (e.g. `stripe.com`).
2. **It scans that website**: the homepage, `/careers`, `/jobs`, and any "Careers / Join us" links it finds.
3. **It uses only what the company itself publishes:**
   - the official hiring board the site links to (**Greenhouse, Lever, Ashby, SmartRecruiters, Workable**), read through that board's public API, and
   - jobs posted directly on the company's careers pages with standard `schema.org/JobPosting` data (the same data Google Jobs reads).
4. Every job links to the company's own application page. Expired postings are dropped, and postings open more than 90 days are flagged.

If the domain doesn't exist, the site is down, or the site doesn't list any jobs, the company isn't added.

## Company check: "Is this real?"

Anyone can search a **company name, website, or a job link** someone sent them. The app checks it and flags anything that doesn't add up:

| Flag | Meaning |
| --- | --- |
| ⛔ Domain not found | The company's website doesn't exist |
| ⛔ Brand-new domain | Website registered less than 6 months ago (checked through the public RDAP registry), a common sign of fake employers |
| ⛔ Job not on official listings | A job link that isn't on the company's own site or official board, or is no longer listed |
| ⚠️ No jobs on the company's site | Offers claiming the company is hiring can't be confirmed |
| ⚠️ Website not loading | The site may be temporarily down; check again later |
| ⚠️ Board not linked from a company site | The job board exists, but we can't confirm which company owns it |
| ⚠️ / ℹ️ Posts open more than 90 days | May already be filled |

Results are saved (`data/checks.json`). Anyone who later searches that company in **Find jobs** sees a warning banner.

## Recruiting-team CSAT

After dealing with a company's recruiters, candidates rate the experience 1 to 5 stars and can answer:
did they reply, were you ghosted partway through, were they respectful of your time, and how far did you get.

- **CSAT = % of ratings that are 4 or 5 stars** (the standard definition), shown once a company has 3 ratings
- One rating per person per company (a new rating replaces your old one), with rate limiting
- Shown on Company check results, on Employer review cards, in the job search banner, and in the note to the employer
- Stored in `data/ratings.json`

## Employer review: posts open more than 90 days

The **Employer review** tab lists every company, big or small, with job posts open longer than 90 days (adjustable to 60/120/180).
For each one it drafts a friendly note asking the company to remove the post if it's filled, or refresh it if they're still looking. The note includes the company's candidate CSAT.

- The hiring email (careers@, jobs@, talent@ …) is taken from the company's own website when it's listed there
- **Open in my email** opens the note in your email app for you to review and send; **Copy note** works for contact forms
- **Mark as sent** records the date. The app waits 30 days before suggesting a follow-up, so companies aren't spammed
- The app never sends email by itself
- In job search, these posts show "⚠ Open N days, may be filled", plus "company notified" once a note has been sent

## Terms, privacy and your data

- **Terms gate**: on the first visit, people see a summary of the Terms of use (English or Spanish) and must tick "I have read and accept" before using the app. Ratings are refused unless the terms were accepted. To ask everyone to accept again after changing the terms, update `TERMS_VERSION` in both `server.js` and `public/app.js`.
- **Footer** on every page: license, Privacy and security, Terms of use, Send feedback, Delete all my data.
- **Send feedback** saves messages to `data/feedback.json` (no email address is shown publicly).
- **Delete all my data** permanently removes the person's ratings, comments and feedback, and clears the app's storage in their browser.

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
| `lib/check.js` | "Is this real?" checks for companies and job links |
| `lib/stale.js` | Finds posts open more than 90 days and drafts the employer note |
| `lib/ratings.js` | Recruiting-team CSAT ratings |
| `public/` | The web page (HTML/CSS/JS) |
| `data/companies.json` | Your list of companies (updated automatically) |
| `data/checks.json`, `data/ratings.json` | Saved check results and candidate ratings (created automatically) |
