#!/usr/bin/env python3
"""Stale Posting Index collector.

Checks company career sites, remembers every posting it has seen in a local
SQLite file, and exports a CSV the Stale Posting Index app can load.

Run it once a day (cron, Task Scheduler, GitHub Actions). Each run updates
first_seen / last_seen for every posting, so over time the data shows:
  * how long the same role has stayed open, and
  * reposts: the same role taken down and put back up under a new ID, or its
    posted date "refreshed" so it looks new. Each repost becomes its own row in
    the export, so the app can count them and flag serial reposters.

Usage:
  python3 collector.py check                 # test every career site, 1 page each
  python3 collector.py collect               # full run, updates postings.db
  python3 collector.py collect --only "NVIDIA,Amazon"
  python3 collector.py collect --only tech             # just the tech focus list
  python3 collector.py collect --only "Cruise Lines"   # one industry
  python3 collector.py collect --only "Home Health Care" # a job-board search (small and local employers)
  python3 collector.py export postings.csv   # CSV for the app's "Load your postings"

Standard library only. Python 3.9+.
"""
import argparse, csv, datetime as dt, json, sqlite3, sys, time, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "postings.db"
UA = "StalePostingIndex/1.0 (job-market research; polite: 1 req/sec)"
DELAY = 1.0          # seconds between requests to the same site
MAX_PER_COMPANY = 3000
TODAY = dt.date.today().isoformat()


# ---------------------------------------------------------------- http
def http(url, data=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"),
                                 headers={"User-Agent": UA, "Accept": "application/json",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read().decode("utf-8", "replace"))
    time.sleep(DELAY)
    return out


def iso(v):
    """Turn the many date formats job sites use into YYYY-MM-DD (or None)."""
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return dt.datetime.utcfromtimestamp(v / 1000 if v > 1e11 else v).date().isoformat()
    s = str(v).strip()
    for cand, fmt in ((s[:10], "%Y-%m-%d"), (s, "%B %d, %Y"), (s, "%b %d, %Y"), (s, "%m/%d/%Y")):
        try:
            return dt.datetime.strptime(cand, fmt).date().isoformat()
        except ValueError:
            pass
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


# ---------------------------------------------------------------- adapters
# Each yields dicts: id, title, location, url, posted (YYYY-MM-DD or None)

def greenhouse(c, pages):
    d = http(f"https://boards-api.greenhouse.io/v1/boards/{c['slug']}/jobs")
    for j in d.get("jobs", []):
        yield dict(id=j["id"], title=j["title"], location=(j.get("location") or {}).get("name", ""),
                   url=j.get("absolute_url", ""), posted=iso(j.get("first_published") or j.get("updated_at")))


def lever(c, pages):
    for j in http(f"https://api.lever.co/v0/postings/{c['slug']}?mode=json"):
        yield dict(id=j["id"], title=j["text"], location=(j.get("categories") or {}).get("location", ""),
                   url=j.get("hostedUrl", ""), posted=iso(j.get("createdAt")))


def ashby(c, pages):
    d = http(f"https://api.ashbyhq.com/posting-api/job-board/{c['slug']}")
    for j in d.get("jobs", []):
        yield dict(id=j["id"], title=j["title"], location=j.get("location", ""),
                   url=j.get("jobUrl", ""), posted=iso(j.get("publishedAt")))


def smartrecruiters(c, pages):
    off = 0
    for _ in range(pages):
        d = http(f"https://api.smartrecruiters.com/v1/companies/{c['slug']}/postings?limit=100&offset={off}")
        rows = d.get("content", [])
        for j in rows:
            loc = j.get("location") or {}
            yield dict(id=j["id"], title=j["name"], location=", ".join(x for x in (loc.get("city"), loc.get("region")) if x),
                       url=f"https://jobs.smartrecruiters.com/{c['slug']}/{j['id']}", posted=iso(j.get("releasedDate")))
        off += 100
        if off >= d.get("totalFound", 0) or not rows:
            break


def workday(c, pages, known=None):
    base = f"https://{c['host']}/wday/cxs/{c['tenant']}/{c['site']}"
    off = 0
    for _ in range(pages):
        d = http(base + "/jobs", {"appliedFacets": {}, "limit": 20, "offset": off, "searchText": ""})
        rows = d.get("jobPostings", [])
        for j in rows:
            path = j.get("externalPath", "")
            jid = (j.get("bulletFields") or [path])[0]
            posted = None
            # The list only says "Posted 30+ Days Ago"; the detail page has the real date.
            # Fetch it once per new posting, then reuse the stored value.
            if known is None or jid not in known:
                try:
                    info = http(base + path).get("jobPostingInfo", {})
                    posted = iso(info.get("startDate"))
                except Exception:
                    pass
            yield dict(id=jid, title=j.get("title", ""), location=j.get("locationsText", ""),
                       url=f"https://{c['host']}/{c['site']}{path}", posted=posted)
        off += 20
        if off >= d.get("total", 0) or not rows:
            break


def eightfold(c, pages):
    off = 0
    for _ in range(pages):
        d = http(f"https://{c['host']}/api/apply/v2/jobs?domain={c['domain']}&start={off}&num=100")
        rows = d.get("positions", [])
        for j in rows:
            yield dict(id=j["id"], title=j.get("name", ""), location=j.get("location", ""),
                       url=j.get("canonicalPositionUrl", ""), posted=iso(j.get("t_create")))
        off += len(rows)
        if not rows or off >= d.get("count", 0):
            break


AMAZON_BRANDS = [  # amazon.jobs company_name -> the Amazon company it's filed under
    (r"web services|\baws\b", "Amazon Web Services (AWS)"), (r"kuiper|amazon leo", "Project Kuiper"),
    (r"\bring\b", "Ring"), (r"audible", "Audible"), (r"imdb", "IMDb"), (r"twitch", "Twitch"),
    (r"zoox", "Zoox"), (r"annapurna", "Annapurna Labs"), (r"robotics", "Amazon Robotics"),
    (r"whole foods", "Whole Foods Market"), (r"zappos", "Zappos"), (r"one medical|1life", "One Medical"),
    (r"mgm|studios", "Amazon MGM Studios"), (r"wondery", "Wondery"), (r"eero", "eero"),
    (r"pharmacy|pillpack", "Amazon Pharmacy"), (r"goodreads", "Goodreads"), (r"\bwoot\b", "Woot"),
    (r"shopbop", "Shopbop"), (r"\bblink\b", "Blink"),
]


def amazon_brand(company_name):
    import re
    for pat, brand in AMAZON_BRANDS:
        if re.search(pat, company_name or "", re.I):
            return brand
    return "Amazon"


def amazon(c, pages):
    off = 0
    for _ in range(pages):
        d = http(f"https://www.amazon.jobs/en/search.json?offset={off}&result_limit=100&sort=recent")
        rows = d.get("jobs", [])
        for j in rows:
            yield dict(id=j.get("id_icims") or j.get("id"), title=j.get("title", ""),
                       company=amazon_brand(j.get("company_name", "")), parent="Amazon",
                       location=j.get("normalized_location") or j.get("location", ""),
                       url="https://www.amazon.jobs" + j.get("job_path", ""), posted=iso(j.get("posted_date")))
        off += 100
        if not rows or off >= d.get("hits", 0):
            break


def adzuna(c, pages):
    """Job-board search by industry/keywords and location, so small and local
    employers (clinics, home-health agencies, contractors...) are covered too.
    Needs a free key from https://developer.adzuna.com in ADZUNA_APP_ID / ADZUNA_APP_KEY."""
    import os, urllib.parse
    app_id, app_key = os.environ.get("ADZUNA_APP_ID"), os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        raise RuntimeError("set ADZUNA_APP_ID and ADZUNA_APP_KEY (free at developer.adzuna.com)")
    q = {"app_id": app_id, "app_key": app_key, "results_per_page": 50, "content-type": "application/json"}
    for k in ("what", "where", "category"):
        if c.get(k):
            q[k] = c[k]
    for page in range(1, min(pages, c.get("max_pages", 10)) + 1):
        d = http(f"https://api.adzuna.com/v1/api/jobs/{c.get('country', 'us')}/search/{page}?" + urllib.parse.urlencode(q))
        rows = d.get("results", [])
        for j in rows:
            yield dict(id=j.get("id"), title=j.get("title", ""), company=(j.get("company") or {}).get("display_name") or "Unknown employer",
                       location=(j.get("location") or {}).get("display_name", ""), url=j.get("redirect_url", ""), posted=iso(j.get("created")))
        if len(rows) < 50:
            break


ADAPTERS = dict(adzuna=adzuna, greenhouse=greenhouse, lever=lever, ashby=ashby, smartrecruiters=smartrecruiters,
                workday=workday, eightfold=eightfold, amazon=amazon)


# ---------------------------------------------------------------- storage
def db():
    con = sqlite3.connect(DB)
    con.execute("""CREATE TABLE IF NOT EXISTS postings (
        company TEXT, industry TEXT, job_id TEXT, title TEXT, location TEXT, url TEXT,
        posted TEXT,            -- date the site says it was posted (this version)
        first_seen TEXT, last_seen TEXT, parent TEXT DEFAULT '',
        PRIMARY KEY (company, job_id, posted))""")
    try:
        con.execute("ALTER TABLE postings ADD COLUMN parent TEXT DEFAULT ''")  # older databases
    except sqlite3.OperationalError:
        pass
    return con


def companies(only=None):
    cfg = json.loads((HERE / "companies.json").read_text())
    cs = cfg["companies"] + [dict(s, ats="adzuna", name=s["label"]) for s in cfg.get("searches", [])]
    if only:
        want = {x.strip().lower() for x in only.split(",")}
        cs = [c for c in cs if c["name"].lower() in want or c["industry"].lower() in want
              or (want & {"tech", "focus"} and c.get("focus"))]
    return cs


def collect(args, pages=None):
    con = db()
    report = []
    for c in companies(args.only):
        if c["ats"] not in ADAPTERS:
            report.append((c["name"], "SKIPPED", f"no endpoint yet, see {c.get('careers', '')}"))
            print(f"  {c['name']:<22} SKIPPED  {report[-1][2]}", flush=True)
            continue
        maxpages = pages or max(1, MAX_PER_COMPANY // 20)
        kw = {}
        if c["ats"] == "workday":
            kw["known"] = {r[0] for r in con.execute("SELECT job_id FROM postings WHERE company=? AND posted IS NOT NULL", (c["name"],))}
        n = 0
        try:
            for j in ADAPTERS[c["ats"]](c, maxpages, **kw):
                jid = str(j["id"])
                co = j.get("company") or c["name"]
                parent = j.get("parent") or c.get("parent", "")
                prev = con.execute("SELECT posted FROM postings WHERE company=? AND job_id=? ORDER BY last_seen DESC LIMIT 1",
                                   (co, jid)).fetchone()
                posted = j["posted"] or (prev[0] if prev else None) or TODAY
                # same job ID with a newer posted date = a "refresh" repost -> stored as its own row
                con.execute("""INSERT INTO postings (company, industry, job_id, title, location, url, posted, first_seen, last_seen, parent)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(company, job_id, posted) DO UPDATE SET last_seen=excluded.last_seen,
                    title=excluded.title, location=excluded.location, url=excluded.url""",
                            (co, c["industry"], jid, j["title"], j["location"], j["url"], posted, TODAY, TODAY, parent))
                n += 1
            con.commit()
            report.append((c["name"], "OK", f"{n} postings"))
        except urllib.error.HTTPError as e:
            report.append((c["name"], "FAILED", f"HTTP {e.code} - check host/slug/site in companies.json"))
        except Exception as e:
            report.append((c["name"], "FAILED", f"{type(e).__name__}: {e}"[:160]))
        print(f"  {report[-1][0]:<22} {report[-1][1]:<8} {report[-1][2]}", flush=True)
    ok = sum(r[1] == "OK" for r in report)
    print(f"\n{ok}/{len(report)} companies collected. Database: {DB}")


def export(args):
    con = db()
    last_run = con.execute("SELECT MAX(last_seen) FROM postings").fetchone()[0]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["company", "parent", "industry", "title", "location", "posted_date", "last_seen", "url", "job_id"])
        for r in con.execute("""SELECT company, parent, industry, title, location, MIN(posted, first_seen), last_seen, url, job_id
                                FROM postings ORDER BY company, title, posted"""):
            r = list(r)
            if r[6] == last_run:
                r[6] = ""   # still listed on the latest run -> the app treats it as open
            w.writerow(r)
    print(f"Wrote {args.out}. Load it in the app with 'Load your postings'.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "collect"):
        p = sub.add_parser(name)
        p.add_argument("--only", help='comma-separated company names, e.g. "NVIDIA,Amazon"')
    p = sub.add_parser("export"); p.add_argument("out", nargs="?", default="postings.csv")
    a = ap.parse_args()
    if a.cmd == "check":
        print("Checking 1 page per company (nothing is saved to the main run)...")
        DB = HERE / "check.db"
        collect(a, pages=1)
    elif a.cmd == "collect":
        collect(a)
    else:
        export(a)
