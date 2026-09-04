"""PissedConsumer customer-service page scraper.

Method: robots.txt itself declares sitemaps. Under
/pc-sitemap/browse/main/ the files customer-services.xml, _1..3.xml and
upload-customer-services.xml enumerate ~157k company customer-service pages
(/company/<slug>/customer-service.html and <brand>.pissedconsumer.com
variants). Those pages carry a labeled contact block: Customer Service:,
<Brand> Website:, Help Center:, Corporate Office Address:, plus a
"How to Reach a Person" section - exactly the corporate contact scope.
Review/complaint text is never parsed.

The full corpus is ~157k pages; --limit bounds the run (frontier is saved so
a later run resumes). Sitemap URL enumeration is cheap and complete.
Usage: python scrapers/pissedconsumer.py [--limit N]
"""

from __future__ import annotations

import argparse
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bs4 import BeautifulSoup

from common import (PoliteFetcher, clean_text, extract_nav_steps,
                    find_phones, log, write_outputs)

SITE = "pissedconsumer"
SITEMAPS = [
    "https://www.pissedconsumer.com/pc-sitemap/browse/main/customer-services.xml",
    "https://www.pissedconsumer.com/pc-sitemap/browse/main/customer-services_1.xml",
    "https://www.pissedconsumer.com/pc-sitemap/browse/main/customer-services_2.xml",
    "https://www.pissedconsumer.com/pc-sitemap/browse/main/customer-services_3.xml",
    "https://www.pissedconsumer.com/pc-sitemap/browse/main/upload-customer-services.xml",
]
FRONTIER = Path(__file__).resolve().parent.parent / "data" / "raw" / SITE / "frontier.json"


def label_value(soup: BeautifulSoup, label_re: str) -> str:
    """Value text following a '<label>:' element (label sits in its own node)."""
    pat = re.compile(label_re, re.I)
    for el in soup.find_all(string=pat):
        parent = el.find_parent()
        if parent is None:
            continue
        parts = []
        for sib in parent.find_next_siblings():
            if pat.search(sib.get_text() or ""):
                break
            t = sib.get_text(" ", strip=True)
            if t:
                parts.append(t)
            if len(parts) >= 3:
                break
        val = clean_text(" ".join(parts))
        if val and "not available" not in val.lower()[:40]:
            return val
    return ""


def parse_cs_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript", "header", "footer", "nav"]):
        t.decompose()

    rec = {"source": SITE, "source_url": url, "phones": [], "emails": [],
           "addresses": [], "websites": [], "hours": "", "nav_steps": []}

    h1 = soup.find("h1")
    brand = ""
    if h1:
        m = re.match(r"Contact\s+(.+?)\s+Customer Service", h1.get_text(), re.I)
        if m:
            brand = clean_text(m.group(1))
    if not brand:
        tail = url.split("pissedconsumer.com/")[1] if "pissedconsumer.com/" in url else url
        if tail.startswith("company/"):
            slug = tail.split("/")[1] if "/" in tail[len("company/"):] else tail[len("company/"):]
        elif "." in tail.split("/")[0] and "/" in tail:
            slug = tail.split("/")[0].split(".")[0]  # <brand>.pissedconsumer.com/...
        else:
            slug = tail.split("/")[0]
        slug = slug.replace(".html", "")
        brand = slug.replace("-", " ").title() if slug else ""
    rec["company"] = brand

    # Brand name used in labels ("17TRACK Website:") varies per page; match generically.
    website = label_value(soup, r"^\s*website\s*:\s*$") or label_value(soup, r"website\s*:")
    if website:
        for u in re.findall(r"[a-z0-9.-]+\.[a-z]{2,}", website, re.I)[:2]:
            if "pissedconsumer" not in u:
                rec["websites"].append(u)

    addr = label_value(soup, r"corporate office address\s*:")
    if addr:
        rec["addresses"].append(clean_text(addr)[:250])

    # Customer Service: block -> phone numbers + emails
    cs = label_value(soup, r"^customer service\s*:\s*$") or label_value(soup, r"customer service\s*:")
    if cs:
        for d in find_phones(cs)[:6]:
            rec["phones"].append({"number": d, "department": "customer service"})
        rec["emails"] = [e for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", cs)][:3]

    # Safety net: phones elsewhere in the verified-contact zone (top of page).
    zone = soup.get_text(" ", strip=True)
    # only take from first ~40% of page to avoid user comments
    head = zone[: len(zone) // 3]
    for d in find_phones(head)[:6]:
        if d not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d, "department": "customer service"})

    # "How to Reach a Person at X" section
    nav = ""
    for h in soup.find_all(["h2", "h3"]):
        if re.search(r"how to reach a person", h.get_text(), re.I):
            container = h.find_parent("section") or h.find_parent("div")
            if container is not None:
                nav = clean_text(container.get_text(" ", strip=True))
                cut = nav.lower().find("contact information")
                if cut > 0:
                    nav = nav[:cut]
            break
    if nav:
        rec["nav_steps"] = extract_nav_steps(nav)
        rec["reach_human_note"] = nav[:300]

    if not (rec["phones"] or rec["emails"] or rec["addresses"] or rec["websites"]):
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=2500,
                    help="max pages to fetch this run (0 = everything; ~157k!)")
    args = ap.parse_args()

    f = PoliteFetcher(SITE, delay=1.1, jitter=0.5, allowed_hosts=(".pissedconsumer.com",))

    # 1) enumerate all customer-service URLs from declared sitemaps
    urls: list[str] = []
    for sm in SITEMAPS:
        got = [u for u in f.get_xml_urls(sm) if u.endswith("customer-service.html")]
        log.info("%s -> %d cs urls", sm.rsplit('/', 1)[-1], len(got))
        urls.extend(got)
    urls = sorted(set(urls))
    log.info("pissedconsumer total cs pages: %d", len(urls))

    donefile_path = FRONTIER.parent / "done_urls.txt"
    done: set[str] = set(
        donefile_path.read_text(encoding="utf-8").splitlines()
        if donefile_path.exists() else []
    )
    FRONTIER.parent.mkdir(parents=True, exist_ok=True)
    todo = [u for u in urls if u not in done]
    # shuffle lightly so a bounded run samples across the alphabet
    random.Random(42).shuffle(todo)
    if args.limit:
        todo = todo[: args.limit]
    log.info("to fetch this run: %d (already done: %d)", len(todo), len(done))

    records: list[dict] = []
    out_json = FRONTIER.parent.parent.parent / f"{SITE}.json"
    done_f = (FRONTIER.parent / "done_urls.txt").open("a", encoding="utf-8")
    for i, u in enumerate(todo, 1):
        html = f.get(u)
        done_f.write(u + "\n")
        if html is None:
            continue
        try:
            rec = parse_cs_page(u, html)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
        if i % 100 == 0:
            log.info("pc %d/%d, %d records, stats=%s", i, len(todo), len(records), f.stats)
            write_outputs(SITE, records)
            done_f.flush()
    done_f.close()
    write_outputs(SITE, records)
    log.info("DONE pissedconsumer: %d records this run, stats=%s", len(records), f.stats)


if __name__ == "__main__":
    main()
