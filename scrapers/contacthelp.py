"""ContactHelp.com scraper.

Method: no sitemap. /companies lists top-level categories; each
/companies/<Category>[/<Subcategory>] page links company pages of the form
/<Company Name>/customer-service (URL-encoded). We BFS the category tree,
then fetch every company page. Pages expose labeled blocks:
Phone:, How to reach a live person:, Hours of Operation:, Email:,
Customer service link:, Main Company URL:, Description:.
Usage: python scrapers/contacthelp.py [--limit N]
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

SITE = "contacthelp"
BASE = "https://www.contacthelp.com"
CAT_SEED = f"{BASE}/companies"
COMPANY_RE = re.compile(r"^/([^/]+)/customer-service$")


def label_value(soup: BeautifulSoup, label: str) -> str:
    """Text following a '<label>:' bold marker anywhere in the page."""
    pat = re.compile(re.escape(label) + r"\s*:?", re.I)
    for b in soup.find_all(["b", "strong"]):
        if pat.search(b.get_text()):
            parts = []
            for sib in b.find_next_siblings():
                if sib.name in ("b", "strong"):
                    break
                parts.append(sib.get_text(" ", strip=True))
            return clean_text(" ".join(parts))
    return ""


def parse_company_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    rec = {"source": SITE, "source_url": url, "phones": [], "emails": [],
           "addresses": [], "websites": [], "hours": "", "nav_steps": [],
           "department": "customer service"}

    slug = COMPANY_RE.match(urllib.parse.urlparse(url).path)
    rec["company"] = urllib.parse.unquote(slug.group(1)) if slug else ""

    h1 = soup.find("h1")
    if h1 and not rec["company"]:
        rec["company"] = clean_text(h1.get_text())

    phone_txt = label_value(soup, "Phone")
    # Phone often sits inside one anchor node: "Phone: 866-216-1072"
    m = re.search(r"Phone\s*:\s*((?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})", soup.get_text(" ", strip=True))
    if m:
        phone_txt += " " + m.group(1)
    for d in find_phones(phone_txt)[:5]:
        rec["phones"].append({"number": d, "department": "customer service"})

    human_txt = label_value(soup, "How to reach a live person")
    rec["nav_steps"] = extract_nav_steps(human_txt)
    rec["reach_human_note"] = clean_text(human_txt)[:300]

    hours_txt = label_value(soup, "Hours of Operation")
    if hours_txt and "not been added" not in hours_txt:
        rec["hours"] = clean_text(hours_txt)[:200]

    email_txt = label_value(soup, "Email")
    if email_txt and "not been added" not in email_txt:
        rec["emails"] = [e for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", email_txt)][:3]

    link_txt = label_value(soup, "Customer service link")
    for u in re.findall(r"https?://\S+", link_txt):
        rec["websites"].append(u.rstrip(" .,)"))

    url_txt = label_value(soup, "Main Company URL")
    for u in re.findall(r"https?://\S+", url_txt):
        u = u.rstrip(" .,)")
        if u not in rec["websites"]:
            rec["websites"].append(u)

    if not (rec["phones"] or rec["emails"] or rec["websites"]):
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    f = PoliteFetcher(SITE, delay=0.8, jitter=0.4, allowed_hosts=("www.contacthelp.com",))

    # 1) BFS the category tree
    seen_cats: set[str] = set()
    queue = [CAT_SEED]
    company_urls: list[str] = []
    seen_companies: set[str] = set()
    while queue:
        cat = queue.pop(0)
        if cat in seen_cats:
            continue
        seen_cats.add(cat)
        html = f.get(cat)
        if html is None:
            continue
        soup = BeautifulSoup(html, "lxml")
        for a in soup.find_all("a", href=True):
            href = a["href"]
            path = urllib.parse.urlparse(href).path
            m = COMPANY_RE.match(path)
            if m:
                full = BASE + href if href.startswith("/") else href
                full = full.split("#")[0]
                if full not in seen_companies:
                    seen_companies.add(full)
                    company_urls.append(full)
            elif path.startswith("/companies/") and path.count("/") >= 2:
                full = BASE + path
                if full not in seen_cats and full not in queue:
                    queue.append(full)
        log.info("cat %s -> %d companies so far (queue %d)", cat, len(company_urls), len(queue))

    log.info("contacthelp: %d category pages, %d company pages", len(seen_cats), len(company_urls))
    if args.limit:
        company_urls = company_urls[: args.limit]

    records: list[dict] = []
    for i, u in enumerate(company_urls, 1):
        html = f.get(u)
        if html is None:
            continue
        try:
            rec = parse_company_page(u, html)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
        if i % 50 == 0:
            log.info("contacthelp %d/%d, %d records, stats=%s", i, len(company_urls), len(records), f.stats)
            write_outputs(SITE, records)
    write_outputs(SITE, records)
    log.info("DONE contacthelp: %d records, stats=%s", len(records), f.stats)


if __name__ == "__main__":
    main()
