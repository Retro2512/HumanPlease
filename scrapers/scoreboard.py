"""CustomerServiceScoreboard.com scraper.

Method: no sitemap; /company_index.php is a single page listing every company
(/CompanyName URLs, ~1,000+). Each company page has a structured contact
block (phone numbers, sometimes department labels and hours) above the user
review stream. We parse only the structured contact block; user comment text
is out of scope and skipped. robots.txt disallows /popups and ?type=json -
we use plain HTML pages only.
Usage: python scrapers/scoreboard.py [--limit N]
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bs4 import BeautifulSoup

from common import (PoliteFetcher, clean_text, extract_nav_steps,
                    find_phones, log, write_outputs)

SITE = "scoreboard"
BASE = "https://www.customerservicescoreboard.com"
INDEX = f"{BASE}/company_index.php"

SKIP_EXT = re.compile(r"\.(php|css|js|png|jpe?g|ico|svg)$", re.I)


def parse_company_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    rec = {"source": SITE, "source_url": url, "phones": [], "emails": [],
           "addresses": [], "websites": [], "hours": "", "nav_steps": []}

    h1 = soup.find("h1", class_=re.compile("company", re.I)) or soup.find("h1")
    name = clean_text(h1.get_text()) if h1 else ""
    name = re.sub(r"\s+customer service$|\s+Customer Service$", "", name, flags=re.I).strip()
    rec["company"] = name or urllib.parse.unquote(url.rstrip("/").rsplit("/", 1)[-1]).replace("+", " ")

    # Contact info lives in a titled-box: <h6>Contact Information</h6> then
    # repeating <strong>Department</strong><br> <number> <hr>
    box = None
    for b in soup.find_all("div", class_="titled-box"):
        title = b.find(class_="titled-box-title")
        if title and "contact information" in title.get_text().lower():
            box = b.find(class_="titled-box-content") or b
            break
    if box is not None:
        current_label = "customer service"
        for el in box.descendants:
            if getattr(el, "name", None) == "strong":
                txt = clean_text(el.get_text())
                if txt and not find_phones(txt):
                    current_label = txt.lower()[:60]
            else:
                txt = el.get_text(" ", strip=True) if hasattr(el, "get_text") and el.name not in ("strong",) else ""
                for d in find_phones(txt or ""):
                    if d not in [p["number"] for p in rec["phones"]]:
                        rec["phones"].append({"number": d, "department": current_label})
    # fallback: any phones in the pre-review region of the page
    body_text = soup.get_text(" ", strip=True)
    pre_review = body_text.split("User Reviews")[0] if "User Reviews" in body_text else body_text[:4000]
    for d in find_phones(pre_review)[:8]:
        if d not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d, "department": "customer service"})

    # Some pages carry an explicit 'how to reach/talk to a person' hint block.
    nav_txt = ""
    for h in soup.find_all(["h2", "h3"]):
        if re.search(r"how (to|do i) (reach|talk|get)", h.get_text(), re.I):
            parts = []
            for sib in h.find_next_siblings():
                if sib.name in ("h1", "h2", "h3"):
                    break
                parts.append(sib.get_text(" ", strip=True))
            nav_txt = clean_text(" ".join(parts))
            break
    if nav_txt:
        rec["nav_steps"] = extract_nav_steps(nav_txt)
        rec["reach_human_note"] = nav_txt[:300]

    if not (rec["phones"] or rec["emails"] or rec["nav_steps"]):
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    f = PoliteFetcher(SITE, delay=0.7, jitter=0.3, allowed_hosts=("www.customerservicescoreboard.com",))
    html = f.get(INDEX)
    if html is None:
        log.error("cannot fetch company index")
        return
    soup = BeautifulSoup(html, "lxml")
    companies: list[str] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        path = urllib.parse.urlparse(href).path
        if (href.startswith("/") and path.count("/") == 1 and len(path) > 2
                and not SKIP_EXT.search(path) and path not in ("/",)
                and "company_index" not in path):
            # hrefs are already server-correct ('+' for spaces, %xx for
            # punctuation); only repair accidental double-encoding (%25xx).
            path = path.replace("%25", "%")
            full = BASE + path
            if full not in seen:
                seen.add(full)
                companies.append(full)
    log.info("scoreboard: %d company pages discovered", len(companies))
    if args.limit:
        companies = companies[: args.limit]

    records: list[dict] = []
    for i, u in enumerate(companies, 1):
        pg = f.get(u)
        if pg is None:
            continue
        try:
            rec = parse_company_page(u, pg)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
        if i % 100 == 0:
            log.info("scoreboard %d/%d, %d records, stats=%s", i, len(companies), len(records), f.stats)
            write_outputs(SITE, records)
    write_outputs(SITE, records)
    log.info("DONE scoreboard: %d records, stats=%s", len(records), f.stats)


if __name__ == "__main__":
    main()
