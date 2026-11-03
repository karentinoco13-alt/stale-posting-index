# Stale Posting Index

Spot employers, from tech giants to local hospitals, clinics and contractors, that keep the same job posted for months or repost it so it looks new. Job seekers learn where not to waste their time. Hiring teams see which roles competitors can't fill.

**Live app:** https://claude.ai/artifact/JfsfahG8xvUsNsuw9Fnrox

## What's in this repository

| Folder | What it is |
|---|---|
| `app/index.html` | The app: one self-contained page in English and Spanish. |
| `collector/` | A Python script that checks career sites and job boards daily and exports a CSV the app can load. See [`collector/README.md`](collector/README.md). |

## Features

- **Company ranking** by how long the same role has stayed open past 3 months, with a **Serial reposter** flag for jobs posted 3 or more times.
- **Filters** by industry, employer size (big names or smaller and local), time open and search.
- **Community reports:** users report jobs posted for more than 3 months, flag them and comment. *(claude.ai only)*
- **Fraud check** for recruiter emails, and a **job posting red-flag check** for signs an employer takes advantage of workers.
- **Terms gate**, Privacy & security, Terms, Content removal and Copyright pages, a 30-day feedback box *(claude.ai only)*, and "Delete all my data".

## Know the catch

- **Not live yet.** The app doesn't pull jobs from the web by itself. It ranks postings people add, files from the collector, and community reports.
- **Coverage is partial**, and long-open roles can be legitimate.
- Rankings, reports and checks are signals, not verified facts.

## Running the app outside claude.ai

Open `app/index.html` in a browser, or serve it with GitHub Pages. Rankings, uploads and the fraud checks work anywhere, and data stays in the browser. **Community reports and feedback use claude.ai's shared storage**, so outside claude.ai they show a notice instead.

## Credits and license

Designed and directed by Karen Tinoco; implemented with Claude Code as an AI pair programmer.
© 2026 Karen Tinoco. Licensed under [PolyForm Noncommercial 1.0.0](LICENSE): free to use, share and adapt for non-commercial purposes, with credit. Commercial use by permission only.
