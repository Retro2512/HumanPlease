"""GetHuman phone-number page scraper.

Method: /sitemap.xml lists sitemaps; the ones that render server-side XML are
companies.xml (Angular-shell directory pages - useless for data) and
method.phone.xml (3,541 server-rendered phone pages). Each
/phone-number/<Company>/<department>/~id page is SSR HTML with:
  - title/h1 carrying company, department and the primary number
  - Q&A-style sections: how to reach a human, how to get through the phone
    menu, hours, best/least-busy times, expected hold time
  - a "More <Company> Customer Phone Numbers" block with other departments.
robots.txt disallows /api/ and /ng2api/ - we never touch those; only the
declared sitemap + public HTML pages.
Usage: python scrapers/gethuman.py [--limit N]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bs4 import BeautifulSoup

from common import (DATA, PoliteFetcher, clean_text, extract_nav_steps,
                    find_phones, log, write_outputs)

SITE = "gethuman"
SITEMAP = "https://gethuman.com/sitemaps/method.phone.xml"
URL_RE = re.compile(r"/phone-number/([^/]+)/([^/]+)/~?([A-Za-z0-9_-]+)$")


def section_after(soup: BeautifulSoup, heading_pat: str) -> str:
    """Text of the block following a heading matching heading_pat."""
    pat = re.compile(heading_pat, re.I)
    for h in soup.find_all(["h2", "h3", "h4"]):
        if pat.search(h.get_text()):
            parts = []
            for sib in h.find_next_siblings():
                if sib.name in ("h1", "h2", "h3", "h4"):
                    break
                parts.append(sib.get_text(" ", strip=True))
            return clean_text(" ".join(parts))
    return ""


def parse_phone_page(url: str, html: str) -> dict | None:
    m = URL_RE.search(url)
    if not m:
        return None
    company_slug, dept_slug, _id = m.group(1), m.group(2), m.group(3)
    company = company_slug.replace("-", " ")
    dept = dept_slug.replace("-", " ")

    soup = BeautifulSoup(html, "lxml")

    title = clean_text(soup.title.string or "") if soup.title else ""
    primary = ""
    for d in find_phones(title):
        primary = d
        break

    rec = {
        "source": SITE,
        "source_url": url,
        "company": company,
        "department": dept,
        "phones": [],
        "nav_steps": [],
        "hours": "",
        "wait_time": "",
        "best_time_to_call": "",
        "notes": [],
    }
    if primary:
        rec["phones"].append({"number": primary, "department": dept})

    # Q&A sections -> concise facts
    human_txt = section_after(soup, r"talk to a human|get through the phone menu")
    rec["nav_steps"] = extract_nav_steps(human_txt)

    hours_txt = section_after(soup, r"hours and when should i call|does this phone number work")
    hm = re.search(r"(24/7|24 hours|monday[^.]*?|open[^.]*?close[^.]*?)", hours_txt, re.I)
    if hours_txt:
        rec["hours"] = clean_text(hours_txt.split(". ")[0])[:160]
    wait_txt = section_after(soup, r"how long will i have to wait|wait on hold|wait to speak")
    wm = re.search(r"((?:\d+(?:\.\d+)?)\s*(?:min|minute|hour|sec)[^.]*|average wait[^.]*|hold for[^.]*)", wait_txt, re.I)
    if wm:
        rec["wait_time"] = clean_text(wm.group(0))[:120]
    best_txt = section_after(soup, r"least busy time|best time to call")
    if best_txt:
        rec["best_time_to_call"] = clean_text(best_txt.split(". ")[0])[:160]

    # "More <Company> Customer Phone Numbers" - other dept numbers, often as
    # links like /phone-number/<Company>/<dept>/~id inside a list.
    for a in soup.find_all("a", href=True):
        m2 = URL_RE.search(a["href"])
        if not m2:
            continue
        d = find_phones(a.get_text(" ", strip=True))
        other_dept = m2.group(2).replace("-", " ")
        if d and d[0] not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d[0], "department": other_dept})

    # Fallback: phones visible anywhere on page not yet captured (max 8)
    all_phones = find_phones(soup.get_text(" ", strip=True))
    for d in all_phones[:8]:
        if d not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d, "department": "listed on page"})

    if not rec["phones"]:
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    f = PoliteFetcher(SITE, delay=0.8, jitter=0.4, allowed_hosts=("gethuman.com", "www.gethuman.com"))
    urlfile = DATA / "raw" / SITE / "urls.txt"
    if urlfile.exists():
        urls = [u for u in urlfile.read_text(encoding="utf-8").splitlines() if URL_RE.search(u)]
    else:
        urls = [u for u in f.get_xml_urls(SITEMAP) if URL_RE.search(u)]
    log.info("gethuman phone pages: %d", len(urls))
    if args.limit:
        urls = urls[: args.limit]

    records: list[dict] = []
    for i, u in enumerate(urls, 1):
        html = f.get(u)
        if html is None:
            continue
        try:
            rec = parse_phone_page(u, html)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
        if i % 100 == 0:
            log.info("gethuman %d/%d, %d records, stats=%s", i, len(urls), len(records), f.stats)
            write_outputs(SITE, records)
    write_outputs(SITE, records)
    log.info("DONE gethuman: %d records, stats=%s", len(records), f.stats)


if __name__ == "__main__":
    main()
