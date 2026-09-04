"""Elliott Advocacy company-contacts scraper.

Method: Yoast sitemap index lists contacts-sitemap.xml + contacts-sitemap2.xml
(1,702 pages). Each page carries Organization JSON-LD (name, telephone,
address, url) plus mailto links for department/executive contacts and an
HTML "executives" section. We keep structured fields only; personal names
are deliberately dropped (role-level contacts kept).
Usage: python scrapers/elliott.py [--limit N]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bs4 import BeautifulSoup

from common import PoliteFetcher, clean_text, find_phones, load_json, log, write_outputs

SITE = "elliott"
SITEMAPS = [
    "https://www.elliott.org/contacts-sitemap.xml",
    "https://www.elliott.org/contacts-sitemap2.xml",
]


def parse_ld_orgs(soup: BeautifulSoup) -> list[dict]:
    out = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except Exception:
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if isinstance(obj, dict) and obj.get("@type") == "Organization":
                out.append(obj)
    return out


def addr_str(a: dict) -> str:
    if not isinstance(a, dict):
        return ""
    parts = [
        clean_text(a.get("streetAddress", "")),
        clean_text(a.get("addressLocality", "")),
        clean_text(a.get("addressRegion", "")),
        clean_text(str(a.get("postalCode", "")) or ""),
        clean_text(a.get("addressCountry", "")),
    ]
    return clean_text(", ".join(p for p in parts if p).replace(", ,", ", "))


def parse_contact_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    rec: dict = {"source": SITE, "source_url": url, "phones": [], "emails": [],
                 "addresses": [], "websites": [], "exec_contacts": []}

    orgs = parse_ld_orgs(soup)
    if orgs:
        org = orgs[0]
        rec["company"] = clean_text(org.get("name", ""))
        tel = org.get("telephone", "")
        if tel:
            for d in find_phones(str(tel)):
                rec["phones"].append({"number": d, "department": "main (Elliott listing)"})
        a = addr_str(org.get("address", {}))
        if a:
            rec["addresses"].append(a)
        if org.get("url"):
            rec["websites"].append(clean_text(str(org["url"])))

    if not rec.get("company"):
        h1 = soup.find("h1")
        if h1:
            rec["company"] = clean_text(h1.get_text())
        else:
            return None

    # mailto contacts: department addresses vs personal exec addresses.
    # We keep the address (published for consumer escalation) but drop names.
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.lower().startswith("mailto:"):
            email = clean_text(href[7:]).split("?")[0]
            if "@" in email and not email.endswith(("example.com", "sentry.io", "wixpress.com")):
                rec["emails"].append(email)

    # Executive contacts section: pair each mailto with the nearest preceding
    # role text if present, but strip person names (first Last pattern).
    exec_section = None
    for h in soup.find_all(["h2", "h3"]):
        if "executive" in h.get_text().lower():
            exec_section = h.find_parent(["section", "div"])
            break
    if exec_section:
        text = exec_section.get_text(" ", strip=True)
        for d in find_phones(text):
            if d not in [p["number"] for p in rec["phones"]]:
                rec["phones"].append({"number": d, "department": "executive relations (Elliott listing)"})

    # "How to resolve" section sometimes lists the main CS line; capture phones
    # from the whole page as a safety net, labeled generically.
    body_text = soup.get_text(" ", strip=True)
    for d in find_phones(body_text)[:6]:
        if d not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d, "department": "listed on page"})

    rec["emails"] = sorted(set(rec["emails"]))
    rec["websites"] = sorted(set(rec["websites"]))
    if not (rec["phones"] or rec["emails"] or rec["addresses"]):
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="max pages to fetch (0 = all)")
    args = ap.parse_args()

    f = PoliteFetcher(SITE, delay=0.9, jitter=0.4, allowed_hosts=("www.elliott.org",))
    urls: list[str] = []
    for sm in SITEMAPS:
        got = f.get_xml_urls(sm)
        urls += [u for u in got if "/company-contacts/" in u]
        log.info("%s -> %d contact urls", sm, len(got))
    urls = sorted(set(urls))
    log.info("total elliott contact pages: %d", len(urls))
    if args.limit:
        urls = urls[: args.limit]

    records: list[dict] = []
    for i, u in enumerate(urls, 1):
        html = f.get(u)
        if html is None:
            continue
        try:
            rec = parse_contact_page(u, html)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
        if i % 50 == 0:
            log.info("elliott %d/%d pages, %d records, stats=%s", i, len(urls), len(records), f.stats)
            write_outputs(SITE, records)
    write_outputs(SITE, records)
    log.info("DONE elliott: %d records from %d pages, stats=%s", len(records), len(urls), f.stats)


if __name__ == "__main__":
    main()
