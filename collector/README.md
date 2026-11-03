# Stale Posting Index collector

Checks company career sites once a day and remembers every job posting it sees. Its CSV feeds the Stale Posting Index app (Add postings, then Upload a file).

Running it every day builds up first-seen and last-seen dates for each posting, which is what shows:
- how long the same role has stayed open, and
- **reposts**: the same role taken down and put back up under a new ID, or with its date refreshed to look new. Each repost is a separate row, and the app flags companies that do it 3 or more times as **Serial reposters**.

## Watchlist (`companies.json`)

94 companies. Tech is the focus and listed first (Apple, Microsoft, NVIDIA, Amazon, Blue Origin, Tesla, SpaceX, Salesforce, Google, Meta and more). Every company is collected by default:

- **Amazon companies**: amazon.jobs postings are filed under the Amazon company that posted them, for example AWS, Project Kuiper, Ring, Audible, IMDb, Annapurna Labs or Amazon Robotics. Whole Foods Market, Zappos, Twitch, Zoox, One Medical, Amazon MGM Studios and Wondery are also listed. All carry `parent = Amazon`, and searching "Amazon" in the app finds all of them.
- **Drones & aerial tech**: Skydio, Zipline, Wing, Shield AI, AeroVironment, Joby, Archer, BRINC
- **Airlines**: Delta, American, United, Southwest, JetBlue, Alaska, Spirit, Frontier, Hawaiian
- **Cruise lines**: Royal Caribbean Group, Carnival, Norwegian Cruise Line Holdings, Virgin Voyages, MSC, Disney Cruise Line
- **Homebuilding & construction**: Lennar, D.R. Horton, PulteGroup, NVR, Toll Brothers, KB Home, Taylor Morrison, Meritage, Bechtel, Turner, Kiewit, Fluor
- Also aerospace and defense, automotive, retail, banking, healthcare, pharma, energy, media, telecom, logistics, hospitality, consumer goods and consulting

**Status:** none of the career-site endpoints could be tested yet, because the build environment's network blocks them. 30 companies have a best-known endpoint (Workday, Greenhouse, Lever, Eightfold or amazon.jobs). The other 64 are `ats: "unknown"` with their careers page listed, and their endpoint still has to be found. Run `check` first.

## Small and local employers

Small employers usually have no career site of their own. They post on job boards. So the collector also runs **job-board searches** by industry, through the free Adzuna jobs API, and those pick up every employer posting in that field: hospitals, clinics, home-health agencies, nursing homes and assisted living, behavioral health, construction trades and laborers, staffing agencies, trucking, warehousing, restaurants, cleaning, security, call centers, childcare, landscaping and auto repair.

1. Get a free key at https://developer.adzuna.com.
2. Set it before running:

```bash
export ADZUNA_APP_ID=your_id ADZUNA_APP_KEY=your_key
```

3. To focus on your area, set `"where"` on each search in `companies.json` (for example `"Miami, FL"`). Searches are nationwide by default.

## Run it

Needs Python 3.9+ and no other packages.

```bash
python3 collector.py check
```

```bash
python3 collector.py collect
```

```bash
python3 collector.py export postings.csv
```

Narrow a run with `--only`, using company names, an industry, or `tech`:

```bash
python3 collector.py collect --only tech
```

```bash
python3 collector.py collect --only "Cruise Lines,Lennar,Amazon"
```

Run `collect` once a day, for example with cron at 7:12 every morning:

```bash
12 7 * * * cd /path/to/stale-postings && python3 collector.py collect && python3 collector.py export postings.csv
```

It sends at most about one request per second per site. Check each site's terms before you collect from it.

## Licence

© 2026 Karen Tinoco. Licensed under PolyForm Noncommercial 1.0.0 (https://polyformproject.org/licenses/noncommercial/1.0.0/): free to use, share and adapt for non-commercial purposes, with credit. Commercial use by permission only.
