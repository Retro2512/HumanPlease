"""Merge per-site extractions into clean, deduplicated master datasets.

Outputs (under data/):
  master_contacts.csv  - one row per company: phones (with departments),
                         emails, addresses, websites, hours, sources
  master_contacts.json - same, nested, with per-number source attribution
  phone_routes.csv     - one row per company x source phone-tree route:
                         keypress steps, wait time, best time to call
  phone_routes.json    - same, nested
  coverage.json        - per-source counts for the coverage report

Company dedupe key: lowercase, punctuation-stripped name (e.g. "at&t" ==
"AT&T"). Phone dedupe within a company across sources; each phone keeps the
list of sources and departments it was seen with.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, is_tollfree, pretty_phone, clean_text

SOURCES = ["gethuman", "elliott", "contacthelp", "scoreboard",
           "pissedconsumer", "justuseapp", "whistleout"]

NAME_NOISE = re.compile(r"\b(inc|llc|ltd|corp|corporation|co|company|com|llp|plc)\b\.?", re.I)
LEAD_NOISE = re.compile(r"^(how to (?:contact|get|reach|talk to)?|contact(?! us))\s+", re.I)
DUP_PREFIX = re.compile(r"^((?:[a-z0-9&.'+!]+\s+)+)\1", re.I)


def csv_safe(value):
    """Prevent spreadsheet programs from treating scraped text as a formula."""
    if not isinstance(value, str):
        return value
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value


def csv_row(values):
    return [csv_safe(value) for value in values]


def name_key(name: str) -> str:
    n = (name or "").lower().strip()
    n = re.sub(r"[^a-z0-9&+ ]+", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    n = LEAD_NOISE.sub("", n).strip()
    n = NAME_NOISE.sub("", n).strip()
    return n


def clean_display(name: str) -> str:
    # collapse repeated brand prefixes like "AT&T AT&T Internet"
    for _ in range(2):
        new = DUP_PREFIX.sub(r"\1", name)
        if new == name:
            break
        name = new
    return name.strip()


def main() -> None:
    companies: dict[str, dict] = {}
    coverage = {}

    for src in SOURCES:
        path = DATA / f"{src}.json"
        if not path.exists():
            coverage[src] = {"records": 0, "note": "not run"}
            continue
        try:
            records = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            coverage[src] = {"records": 0, "note": f"unreadable: {e}"}
            continue
        n_phones = n_routes = 0
        for rec in records:
            key = name_key(rec.get("company", ""))
            if not key or key in ("unknown", "unknown app", ""):
                continue
            entry = companies.setdefault(key, {
                "display_name": rec.get("company", "").strip(),
                "sources": [],
                "phones": [],          # {number, pretty, tollfree, departments, sources}
                "emails": [], "addresses": [], "websites": [],
                "hours": [], "phone_routes": [],
            })
            if src not in entry["sources"]:
                entry["sources"].append(src)
            # prefer the longest display name (usually most complete)
            if len(rec.get("company", "")) > len(entry["display_name"]):
                entry["display_name"] = rec["company"].strip()
            for p in rec.get("phones", []):
                num = p.get("number", "")
                if not num:
                    continue
                slot = next((x for x in entry["phones"] if x["number"] == num), None)
                if slot is None:
                    slot = {"number": num, "pretty": pretty_phone(num),
                            "tollfree": is_tollfree(num), "departments": [], "sources": []}
                    entry["phones"].append(slot)
                    n_phones += 1
                dept = clean_text(p.get("department", ""))[:60]
                if dept and dept not in slot["departments"]:
                    slot["departments"].append(dept)
                if src not in slot["sources"]:
                    slot["sources"].append(src)

            for e in rec.get("emails", []):
                if e and e not in entry["emails"]:
                    entry["emails"].append(e)
            for a in rec.get("addresses", []):
                if a and a not in entry["addresses"]:
                    entry["addresses"].append(clean_text(a)[:250])
            for w in rec.get("websites", []):
                if w and w not in entry["websites"]:
                    entry["websites"].append(w)
            h = clean_text(rec.get("hours", ""))
            if h and "not been added" not in h and h not in entry["hours"]:
                entry["hours"].append(h[:200])

            steps = rec.get("nav_steps") or []
            note = rec.get("reach_human_note") or rec.get("wait_time_note") or ""
            if steps or note:
                entry["phone_routes"].append({
                    "source": src,
                    "source_url": rec.get("source_url", ""),
                    "phone": rec.get("phones", [{}])[0].get("pretty", "") if rec.get("phones") else "",
                    "steps": steps,
                    "wait_time": rec.get("wait_time", ""),
                    "best_time_to_call": rec.get("best_time_to_call", ""),
                    "hours": rec.get("hours", ""),
                    "note": clean_text(note)[:300],
                })
                n_routes += 1
            elif src == "gethuman" and rec.get("phones"):
                # GetHuman pages always describe the route; keep even thin ones
                entry["phone_routes"].append({
                    "source": src, "source_url": rec.get("source_url", ""),
                    "phone": rec["phones"][0].get("number", ""),
                    "steps": [], "wait_time": rec.get("wait_time", ""),
                    "best_time_to_call": rec.get("best_time_to_call", ""),
                    "hours": rec.get("hours", ""), "note": "",
                })
                n_routes += 1
        coverage[src] = {"records": len(records), "unique_phones_added": n_phones,
                         "routes_added": n_routes}

    # rank: toll-free first, then number
    for entry in companies.values():
        entry["phones"].sort(key=lambda p: (not p["tollfree"], p["number"]))

    # ---- write JSON ----------------------------------------------------
    (DATA / "master_contacts.json").write_text(
        json.dumps(companies, indent=2, ensure_ascii=False), encoding="utf-8")

    routes_flat = []
    for key, entry in companies.items():
        for r in entry["phone_routes"]:
            routes_flat.append({"company": clean_display(entry["display_name"]), **r})
    (DATA / "phone_routes.json").write_text(
        json.dumps(routes_flat, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- write CSVs ----------------------------------------------------
    with open(DATA / "master_contacts.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["company", "sources", "phone_count", "phones (pretty | department)",
                    "emails", "addresses", "websites", "hours"])
        for key in sorted(companies):
            e = companies[key]
            phones = " ; ".join(
                f"{p['pretty']} ({', '.join(p['departments'][:2]) or 'general'})"
                for p in e["phones"])
            w.writerow(csv_row([clean_display(e["display_name"]), ",".join(e["sources"]), len(e["phones"]),
                        phones, " ; ".join(e["emails"][:6]),
                        " ; ".join(e["addresses"][:3]), " ; ".join(e["websites"][:4]),
                        " ; ".join(e["hours"][:3])]))

    with open(DATA / "phone_routes.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["company", "source", "phone", "steps", "wait_time",
                    "best_time_to_call", "hours", "note", "source_url"])
        for r in routes_flat:
            w.writerow(csv_row([r["company"], r["source"], r["phone"],
                        " | ".join(r["steps"]), r["wait_time"],
                        r["best_time_to_call"], r["hours"], r["note"],
                        r["source_url"]]))

    coverage["master"] = {
        "companies": len(companies),
        "total_unique_phone_numbers": sum(len(e["phones"]) for e in companies.values()),
        "companies_with_ivr_routes": sum(1 for e in companies.values() if e["phone_routes"]),
        "total_routes": len(routes_flat),
        "routes_with_concrete_steps": sum(1 for r in routes_flat if r["steps"]),
        "emails": sum(len(e["emails"]) for e in companies.values()),
        "addresses": sum(len(e["addresses"]) for e in companies.values()),
    }
    coverage["notes"] = {
        "gethuman": "Complete: all 3,541 phone pages in sitemaps/method.phone.xml (94% yielded data; rest had no SSR content). /api/ + /ng2api/ never used (robots-disallowed).",
        "elliott": "Complete: all 1,702 contacts-sitemap pages. Executive contacts kept at role level without personal names.",
        "contacthelp": "Complete: full /companies category-tree crawl (1,339 companies; some pages have no data published).",
        "scoreboard": "Complete: all 1,253 companies from company_index.php (1,198 yielded contact data).",
        "pissedconsumer": "PARTIAL: 500 of 156,713 CS pages fetched before the host began dropping all connections (per-IP throttle; persisted >8h). Resumable via data/raw/pissedconsumer frontier - rerun scraper later with --limit.",
        "justuseapp": "SAMPLE: 2,500 of 74,463 English /contact pages (developer phone/email/website). Emails are Cloudflare-decoded. Resumable frontier.",
        "whistleout": "Complete: all 56 relevant URLs across 16 sub-sitemaps; only ~30 pages carry corporate contact data.",
    }
    (DATA / "coverage.json").write_text(json.dumps(coverage, indent=2), encoding="utf-8")
    print(json.dumps(coverage, indent=2))


if __name__ == "__main__":
    main()
