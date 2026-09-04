"""WhistleOut customer-service guide scraper.

Method: sitemap.xml index -> 16 sub-sitemaps (8,130 URLs total). Only a
handful of pages are corporate-contact/phone-tree relevant ("How to get a
human from <carrier> customer service", "Customer service phone numbers...").
We filter the full URL list by relevance patterns, fetch those pages, and
extract: phone numbers with labels, ordered how-to-reach-a-human steps, and
phone-number facts from the FAQPage JSON-LD. Guide prose is distilled to
short functional steps only.
Usage: python scrapers/whistleout.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bs4 import BeautifulSoup

from common import (PoliteFetcher, clean_text, extract_nav_steps,
                    find_phones, log, write_outputs)

SITE = "whistleout"
INDEX = "https://www.whistleout.com/sitemap.xml"
RELEVANT = re.compile(
    r"customer-service|phone-numbers|how-to-get-(a-)?human|contact", re.I)


def ordered_steps(soup: BeautifulSoup, heading_pat: str) -> list[str]:
    pat = re.compile(heading_pat, re.I)
    for h in soup.find_all(["h2", "h3"]):
        if pat.search(h.get_text()):
            ol = h.find_next("ol")
            if ol:
                steps = []
                for li in ol.find_all("li"):
                    t = clean_text(li.get_text(" ", strip=True))[:160]
                    if t:
                        steps.append(t)
                if steps:
                    return steps[:12]
            parts = []
            for sib in h.find_next_siblings():
                if sib.name in ("h1", "h2", "h3"):
                    break
                parts.append(sib.get_text(" ", strip=True))
            return extract_nav_steps(" ".join(parts))
    return []


def parse_guide(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    rec = {"source": SITE, "source_url": url, "phones": [], "emails": [],
           "addresses": [], "websites": [], "nav_steps": [], "hours": ""}

    h1 = soup.find("h1")
    title = clean_text(h1.get_text()) if h1 else clean_text(soup.title.string or "")
    m = re.search(r"(?:from|for|of)\s+([A-Z][A-Za-z0-9&.'!+ ]{1,40}?)(?:'s)?\s+customer service", title, re.I)
    company = m.group(1).strip() if m else ""
    if not company:
        m = re.search(r"customer service\s+(?:number|phone numbers?)\s+(?:for|of)\s+([A-Za-z0-9&.'!+ ]{1,40})", title, re.I)
        company = m.group(1).strip() if m else ""
    if not company:
        company = re.sub(r"\s*customer service.*$", "", title, flags=re.I).strip()
        company = re.sub(r"^how to (?:get|reach|talk to)[^A-Za-z0-9]*", "", company, flags=re.I).strip()
        company = re.sub(r"^(?:a |an )?(?:human|live person|person)\s+(?:from|at|on)\s+", "", company, flags=re.I).strip()
    # drop pages about phone features that merely matched the keyword filter
    if re.search(r"contact poster|transfer.*contacts|what is my phone number", title, re.I):
        return None
    # clean brand: leading "Contact", duplicated brand tokens, possessives
    company = re.sub(r"^contact\s+", "", company, flags=re.I).strip()
    tokens = company.split()
    if len(tokens) > 1:
        # collapse repeats like "AT&T AT&T" / "Verizon Wireless Verizon Wireless"
        half = tokens[: len(tokens) // 2]
        if tokens == half + half:
            company = " ".join(half)
    company = re.sub(r"'s?$", "", company.strip())
    rec["company"] = company or title
    rec["page_title"] = title[:120]

    # 1) ordered how-to-reach-a-human steps
    steps = ordered_steps(soup, r"reach a live person|get a human|speak to a human")
    rec["nav_steps"] = steps or extract_nav_steps(soup.get_text(" ", strip=True)[:6000], max_steps=8)

    # 2) FAQ JSON-LD answers - keep only phone-number facts
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except Exception:
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if isinstance(obj, dict) and obj.get("@type") == "FAQPage":
                for q in obj.get("mainEntity", []):
                    ans = (q.get("acceptedAnswer") or {}).get("text", "")
                    qtext = clean_text(q.get("name", ""))[:100]
                    for d in find_phones(ans):
                        if d not in [p["number"] for p in rec["phones"]]:
                            label = qtext if any(c.isdigit() for c in qtext) and "number" in qtext.lower() else "customer service"
                            rec["phones"].append({"number": d, "department": label[:60].lower()})

    # 3) labeled numbers in tables/lists: "<label> ... <number>" rows
    STOP_LABELS = {"call", "dial", "or", "and", "with", "the", "for", "to", "phone", "number", "at"}
    body_text = soup.get_text(" ", strip=True)
    for m in re.finditer(r"([A-Za-z][A-Za-z /&()'-]{2,50}?)\s*(?::|\s)\s*((?:\+?1[\s.\-])?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})", body_text):
        label, num = clean_text(m.group(1)).lower(), m.group(2)
        if label.split()[-1:] and label.split()[-1] in STOP_LABELS:
            continue
        d = find_phones(num)
        if d and d[0] not in [p["number"] for p in rec["phones"]] and len(label) > 3:
            rec["phones"].append({"number": d[0], "department": label[:60]})

    # safety net: toll-free numbers anywhere; scrub URL fragments from labels
    def scrub_label(label: str) -> str:
        label = re.sub(r"\b(?:com|www|https?)/?\S*", "", label)
        label = re.sub(r"\s+", " ", label).strip(" -_:")
        return label[:60]

    for d in find_phones(body_text)[:12]:
        if d not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d, "department": "listed in guide"})
    for p in rec["phones"]:
        p["department"] = scrub_label(p["department"]) or "customer service"

    if not (rec["phones"] or rec["nav_steps"]):
        return None
    return rec


def main() -> None:
    f = PoliteFetcher(SITE, delay=1.0, jitter=0.4, allowed_hosts=("www.whistleout.com",))
    submaps = f.get_xml_urls(INDEX)
    log.info("whistleout: %d sub-sitemaps", len(submaps))
    urls: list[str] = []
    for sm in submaps:
        for u in f.get_xml_urls(sm):
            if RELEVANT.search(u):
                urls.append(u)
    urls = sorted(set(urls))
    log.info("whistleout relevant pages: %d", len(urls))

    records = []
    for u in urls:
        html = f.get(u)
        if html is None:
            continue
        try:
            rec = parse_guide(u, html)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
    write_outputs(SITE, records)
    log.info("DONE whistleout: %d records, stats=%s", len(records), f.stats)


if __name__ == "__main__":
    main()
