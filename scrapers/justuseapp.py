"""JustUseApp app-developer contact scraper.

Method: /sitemap index -> per-locale per-category sitemap segments. English
segments (/en/sitemap/NNNN/<category>/apps) each list 15k URLs of the form
/en/app/<appId>/<slug>/{contact,reviews,problems}. We keep only /contact
pages, which publish the developer's business contact details (phone, email,
website) for the app's support line. Full en corpus ~130k pages - use
--limit to bound a run; done-URLs are tracked for resumption.
Usage: python scrapers/justuseapp.py [--limit N]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bs4 import BeautifulSoup

from common import (PoliteFetcher, clean_text, find_phones,
                    log, write_outputs)

SITE = "justuseapp"
INDEX = "https://justuseapp.com/sitemap"
CONTACT_RE = re.compile(r"^/en/app/[^/]+/[^/]+/contact$")


def decode_cf_emails(soup: BeautifulSoup) -> list[str]:
    """Decode Cloudflare-encoded emails (data-cfemail hex; first byte = XOR key)."""
    out = []
    for el in soup.select("[data-cfemail]"):
        enc = el.get("data-cfemail", "") or ""
        try:
            key = int(enc[:2], 16)
            email = "".join(chr(int(enc[i:i + 2], 16) ^ key) for i in range(2, len(enc), 2))
            if "@" in email:
                out.append(email)
        except (ValueError, IndexError):
            continue
    return out


def bfield(soup: BeautifulSoup, label: str) -> str:
    """Text/first-link value following a <b>label:</b> marker."""
    pat = re.compile(label + r"\s*:?\\?", re.I)
    for b in soup.find_all("b"):
        if pat.search(b.get_text()):
            parts = [b.get_text(" ", strip=True)]
            for sib in b.find_next_siblings():
                if sib.name == "b":
                    break
                t = sib.get_text(" ", strip=True)
                if t:
                    parts.append(t)
                if sib.name == "a":
                    break
            val = clean_text(" ".join(parts))
            return val.replace(label, "", 1).lstrip(": ").strip(" :")
    return ""


def parse_contact_page(url: str, html: str) -> dict | None:
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    rec = {"source": SITE, "source_url": url, "phones": [], "emails": [],
           "addresses": [], "websites": [], "nav_steps": []}

    # company/app name from title "...  Contact  ... - JustUseApp" or h1
    title = clean_text(soup.title.string or "") if soup.title else ""
    h1 = soup.find("h1")
    name = clean_text(h1.get_text()) if h1 else title
    name = re.sub(r"\s*(contact|customer service|support).*$", "", name, flags=re.I).strip()
    if not name:
        m = re.search(r"/app/\d+/([^/]+)/", url)
        name = m.group(1).replace("-", " ") if m else ""
    rec["company"] = name or "unknown app"
    rec["entity_type"] = "app developer support line"

    text = soup.get_text(" ", strip=True)
    rec["developer"] = bfield(soup, r"Developer")

    # labeled contact fields
    rec["emails"] = decode_cf_emails(soup)[:3] or [
        e for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", text[:4000])][:3]
    for label in (r"Contact e-Mail", r"Phone", r"Phone number"):
        val = bfield(soup, label)
        for d in find_phones(val)[:4]:
            rec["phones"].append({"number": d, "department": "app support"})
        if rec["phones"]:
            break
    site = bfield(soup, r"Website")
    for u in re.findall(r"https?://(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})", site, re.I)[:1]:
        if "justuseapp" not in u:
            rec["websites"] = [u]

    head = text[: max(len(text) // 2, 2000)]
    for d in find_phones(head)[:4]:
        if d not in [p["number"] for p in rec["phones"]]:
            rec["phones"].append({"number": d, "department": "app support"})
    if not rec["websites"]:
        for m in re.finditer(r"https?://(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})", head, re.I):
            u = m.group(1)
            if not any(s in u for s in ("justuseapp", "google.com/store", "apple.com", "youtu", "facebook", "twitter", "instagram")):
                if u not in rec["websites"]:
                    rec["websites"].append(u)
    rec["websites"] = rec["websites"][:3]

    if not (rec["phones"] or rec["emails"] or rec["websites"]):
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=2500,
                    help="max pages to fetch this run (0 = all ~130k en contact pages)")
    ap.add_argument("--sitemap-limit", type=int, default=0,
                    help="stop after N sitemap segments (for quick runs)")
    args = ap.parse_args()

    f = PoliteFetcher(SITE, delay=1.0, jitter=0.5, allowed_hosts=("justuseapp.com", "www.justuseapp.com"))

    idx = f.get_xml_urls(INDEX)
    segs = [u for u in idx if "/en/sitemap/" in u]
    log.info("justuseapp: %d en sitemap segments", len(segs))

    raw = Path(__file__).resolve().parent.parent / "data" / "raw" / SITE
    raw.mkdir(parents=True, exist_ok=True)
    urlfile = raw / "en_contact_urls.txt"
    if not urlfile.exists():
        all_urls: list[str] = []
        for i, seg in enumerate(segs, 1):
            got = [u for u in f.get_xml_urls(seg) if CONTACT_RE.match(u.split("justuseapp.com")[1] or "")]
            all_urls.extend(got)
            log.info("seg %d/%d -> %d contact urls (total %d)", i, len(segs), len(got), len(all_urls))
            if args.sitemap_limit and i >= args.sitemap_limit:
                break
        urlfile.write_text("\n".join(sorted(set(all_urls))), encoding="utf-8")
    urls = urlfile.read_text(encoding="utf-8").splitlines()
    log.info("justuseapp contact corpus: %d pages", len(urls))

    donefile = raw / "done_urls.txt"
    done: set[str] = set(donefile.read_text(encoding="utf-8").splitlines() if donefile.exists() else [])
    todo = [u for u in urls if u not in done]
    if args.limit:
        todo = todo[: args.limit]
    log.info("to fetch: %d (done: %d)", len(todo), len(done))

    records: list[dict] = []
    df = donefile.open("a", encoding="utf-8")
    for i, u in enumerate(todo, 1):
        html = f.get(u)
        df.write(u + "\n")
        if html is None:
            continue
        try:
            rec = parse_contact_page(u, html)
        except Exception as e:
            log.warning("parse error %s: %s", u, e)
            continue
        if rec:
            records.append(rec)
        if i % 100 == 0:
            log.info("jua %d/%d, %d records, stats=%s", i, len(todo), len(records), f.stats)
            write_outputs(SITE, records)
            df.flush()
    df.close()
    write_outputs(SITE, records)
    log.info("DONE justuseapp: %d records this run, stats=%s", len(records), f.stats)


if __name__ == "__main__":
    main()
