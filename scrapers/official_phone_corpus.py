"""Harvest public phone numbers from a small, explicit set of official company pages.

This is intentionally conservative: URLs are curated in OFFICIAL_PAGES, only the
same registrable host is accepted, robots.txt is respected by PoliteFetcher, and
no number is copied from third-party directories or guessed from a domain/name.
Run repeatedly as pages change; each result keeps source URL, retrieval date,
visible evidence, and an explicit no-number/failure outcome.
"""
from __future__ import annotations
import argparse, json, re, sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from bs4 import BeautifulSoup
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import PoliteFetcher, normalize_phone, pretty_phone, clean_text

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'data'/'official_phone_manifest.json'
OUT=ROOT/'data'/'official_phone_records.json'
# Curated official support/contact entry points. An absent URL means not yet
# researched, not that the company has no phone number.
OFFICIAL_PAGES={
 'Apple':'https://support.apple.com/contact',
 'Amazon':'https://www.amazon.com/gp/help/customer/contact-us',
 'Walmart':'https://www.walmart.com/help/contact-us',
 'AT&T':'https://www.att.com/support/contact-us/',
 'Verizon Communications':'https://www.verizon.com/support/contact-us/',
 'T-Mobile US':'https://www.t-mobile.com/contact-us',
 'Costco Wholesale':'https://customerservice.costco.com/app/answers/answer_view/a_id/8166',
 'Best Buy':'https://www.bestbuy.com/site/help-topics/contact-us/pcmcat87800050009.c?id=pcmcat87800050009',
 "Lowe's Companies":'https://www.lowes.com/l/help/contact-us',
 'The Home Depot':'https://www.homedepot.com/c/customer_service',
 'FedEx':'https://www.fedex.com/en-us/customer-support.html',
 'United Parcel Service':'https://www.ups.com/us/en/support/contact-us.page',
 'Air Canada':'https://www.aircanada.com/ca/en/aco/home/fly/customer-support/contact-us.html',
 'WestJet':'https://www.westjet.com/en-ca/contact',
 'Bell Canada':'https://support.bell.ca/Contact-us',
 'Rogers Communications':'https://www.rogers.com/contact',
 'TELUS':'https://www.telus.com/en/support/contact-us',
 'Shopify':'https://www.shopify.com/contact',
 'Airbnb':'https://www.airbnb.com/help/contact-us',
 'Uber Technologies':'https://help.uber.com/riders',
 'DoorDash':'https://help.doordash.com/consumers/s/',
 'Lyft':'https://help.lyft.com/hc/en-ca/all',
 'Netflix':'https://help.netflix.com/en/contactus',
 'PayPal Holdings':'https://www.paypal.com/us/cshelp/contact-us',
 'eBay':'https://www.ebay.com/help/home',
 'Etsy':'https://help.etsy.com/hc/en-us',
 'Royal Bank Of Canada':'https://www.rbcroyalbank.com/customer-service/index.html',
 'Toronto Dominion Bank':'https://www.td.com/ca/en/personal-banking/contact-us',
 'Bank of Montreal':'https://www.bmo.com/main/personal/contact-us/',
 'Bank of Nova Scotia':'https://www.scotiabank.com/ca/en/personal/contact-us.html',
 'Canadian Imperial Bank of Commerce':'https://www.cibc.com/en/contact-us.html',
 'Canadian Tire':'https://www.canadiantire.ca/en/customer-service.html',
 'Microsoft':'https://support.microsoft.com/contactus',
 'Home Depot':'https://www.homedepot.com/c/customer_service',
 'The Home Depot':'https://www.homedepot.com/c/customer_service',
 'Walgreens Boots Alliance':'https://www.walgreens.com/topic/help/contactus.jsp',
 'Kroger':'https://www.kroger.com/hc/help/contact-us',
 'Target':'https://help.target.com/help/subcategoryarticle?childcat=Contact+Us',
 'Tesla':'https://www.tesla.com/contactus',
 'Dell Technologies':'https://www.dell.com/support/contents/en-us/category/contact-information',
 'PepsiCo':'https://contact.pepsico.com/',
 'Walt Disney':'https://support.disney.com/',
 'Johnson & Johnson':'https://www.jnj.com/contact-us',
 'Procter & Gamble':'https://us.pg.com/contact-us/',
 "Lowe's":'https://www.lowes.com/l/help/contact-us',
 'Albertsons':'https://www.albertsons.com/contact-us/',
 'Progressive':'https://www.progressive.com/contact-us/',
 'American Express':'https://www.americanexpress.com/us/customer-service/',
 'MetLife':'https://www.metlife.com/contact-us/',
 'HCA Healthcare':'https://hcahealthcare.com/about/contact-us.dot',
 'Allstate':'https://www.allstate.com/help-support/contact-us',
 'Pfizer':'https://www.pfizer.com/contact-us',
 'IBM':'https://www.ibm.com/contact/us/en/',
 'Delta Air Lines':'https://www.delta.com/us/en/need-help/overview',
 'United Airlines Holdings':'https://www.united.com/en/us/fly/help-center.html',
 'TJX':'https://www.tjx.com/contact-us',
 'Coca-Cola':'https://www.coca-colacompany.com/contact-us',
 'Travelers':'https://www.travelers.com/contact-us',
 'Eli Lilly':'https://www.lilly.com/contact-us',
 'Dow':'https://www.dow.com/en-us/contact.html',
 'Thermo Fisher Scientific':'https://www.thermofisher.com/us/en/home/global/contact-us.html',
 'U.S. Bancorp':'https://www.usbank.com/customer-service.html',
 'Abbott Laboratories':'https://www.abbott.com/contact-us.html',
 'Best Buy':'https://www.bestbuy.com/site/help-topics/contact-us/pcmcat87800050009.c?id=pcmcat87800050009',
 'Dollar General':'https://www.dollargeneral.com/contact-us',
 'Qualcomm':'https://www.qualcomm.com/company/contact-us',
 'Honeywell Technologies':'https://www.honeywell.com/us/en/contact',
 'Salesforce':'https://www.salesforce.com/company/contact-us/',
 'Oracle':'https://www.oracle.com/corporate/contact/',
 'Nike':'https://www.nike.com/help/a/contact-us',
 'Cisco Systems':'https://www.cisco.com/c/en/us/about/contact-cisco.html',
 'HP':'https://support.hp.com/us-en/contact',
 'Intel':'https://www.intel.com/content/www/us/en/support/contact-intel.html',
 'Broadcom':'https://www.broadcom.com/company/contact-us',
 'Deere':'https://www.deere.com/en/our-company/contact-us/',
 'Airbnb':'https://www.airbnb.com/help/contact-us',
 'Instacart':'https://www.instacart.com/help/contact',
 'Lyft':'https://help.lyft.com/hc/en-ca/all',
 'JPMorgan Chase':'https://www.chase.com/digital/resources/contact-us',
 'Bank of America':'https://www.bankofamerica.com/customer-service/contact-us/',
 'Citigroup':'https://www.citi.com/contact-us',
 'Wells Fargo':'https://www.wellsfargo.com/help/contact-us/',
 'Goldman Sachs Group':'https://www.goldmansachs.com/about-us/contact-us',
 'Morgan Stanley':'https://www.morganstanley.com/about-us/contact-us',
 'Capital One Financial':'https://www.capitalone.com/help-center/contact-us/',
 'Bank of New York (BNY)':'https://www.bny.com/corporate/global/en/contact-us.html',
 'TIAA':'https://www.tiaa.org/public/support/contact-tiaa',
 'Comcast':'https://www.xfinity.com/support/contact-us',
 'Charter Communications':'https://www.spectrum.com/contact-spectrum',
 'Publix Super Markets':'https://www.publix.com/contact',
 'TJX':'https://www.tjx.com/contact-us',
 'Sysco':'https://www.sysco.com/contact-us.html',
 'Tyson Foods':'https://www.tysonfoods.com/contact-us',
 'United Airlines Holdings':'https://www.united.com/en/us/fly/help-center.html',
 'American Airlines Group':'https://www.aa.com/i18n/customer-service/contact-american.jsp',
 'Southwest Airlines':'https://support.southwest.com/helpcenter/s/contact-us',
 'ConocoPhillips':'https://www.conocophillips.com/contact-us/',
 'General Motors':'https://www.gm.com/contact-us',
 'Ford Motor':'https://www.ford.com/help/contact/',
 'Nvidia':'https://www.nvidia.com/en-us/contact/',
 'Meta Platforms':'https://www.meta.com/help/support/',
 'Alphabet':'https://support.google.com/',
 'CVS Health':'https://www.cvshealth.com/contact-us.html',
 'Walgreens Boots Alliance':'https://www.walgreens.com/topic/help/contactus.jsp',
 'Humana':'https://www.humana.com/contact-us',
 'Aetna':'https://www.aetna.com/about-us/contact-us.html',
 'State Farm Insurance':'https://www.statefarm.com/customer-care/contact-us',
 'USAA':'https://www.usaa.com/support/contact',
 'Liberty Mutual Insurance Group':'https://www.libertymutual.com/contact-us',
 'Nationwide':'https://www.nationwide.com/personal/contact-us/',
 'Boeing':'https://www.boeing.com/contact-us',
 'Caterpillar':'https://www.caterpillar.com/en/company/contact-us.html',
 'GE Aerospace':'https://www.geaerospace.com/contact-us',
 'Wayfair':'https://www.wayfair.com/help-and-contact',
 'eBay':'https://www.ebay.com/help/home',
 'Etsy':'https://help.etsy.com/hc/en-us',
}

def host_ok(source, homepage):
    a=urlparse(source).hostname or ''; b=urlparse(homepage).hostname or ''
    a=a.lower().removeprefix('www.'); b=b.lower().removeprefix('www.')
    return a==b or a.endswith('.'+b) or b.endswith('.'+a)

# Deliberately permissive visual formats, but require a NANP 10-digit result.
PHONE_RE=re.compile(r'(?<![\d])(?:\+?1[\s.\-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.\-]\d{3}[\s.\-]\d{4}(?![\d])')
NON_NA_CONTEXT_RE=re.compile(r'(?i)\b(?:australia|new zealand|united kingdom|england|scotland|wales|ireland|france|germany|italy|spain|japan|china|hong kong|singapore|india|mexico|brazil|south africa|uae|united arab emirates)\b|(?:\+|00)\s*(?:44|61|64|81|86|852|65|91|52|55|27)')

def allowed_context(context):
    return not NON_NA_CONTEXT_RE.search(context or '')

def extract(text,url):
    soup=BeautifulSoup(text,'html.parser')
    for node in soup(['script','style','noscript','svg']): node.decompose()
    visible=clean_text(soup.get_text(' ',strip=True))
    vals=[]
    # Prefer tel links because they are explicit callable organization links.
    for a in soup.select('a[href^="tel:"]'):
        raw=a.get('href','')[4:].split(';',1)[0]
        n=normalize_phone(raw)
        if n:
            context=clean_text(a.parent.get_text(' ',strip=True) if a.parent else a.get_text(' ',strip=True))
            if allowed_context(context): vals.append((n,context or 'Telephone link'))
    for m in PHONE_RE.finditer(visible):
        n=normalize_phone(m.group(0))
        if n:
            context=visible[max(0,m.start()-180):min(len(visible),m.end()+180)]
            if allowed_context(context): vals.append((n,context))
    uniq=[]
    for n,e in vals:
        if n not in [x['number'] for x in uniq]: uniq.append({'number':n,'pretty':pretty_phone(n),'evidence':e[:260]})
    return uniq

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--limit',type=int,default=0); ap.add_argument('--company',action='append',default=[]); ap.add_argument('--delay',type=float,default=0.8); ap.add_argument('--timeout',type=int,default=8); ap.add_argument('--attempts',type=int,default=2); args=ap.parse_args()
    manifest=json.loads(MANIFEST.read_text(encoding='utf8')); targets=manifest['targets']
    # Existing records are preserved for companies not in this run.
    old={x['target_id']:x for x in (json.loads(OUT.read_text(encoding='utf8')).get('records',[]) if OUT.exists() else [])}
    selected=[x for x in targets if x['name'] in OFFICIAL_PAGES and (not args.company or x['name'] in args.company)]
    if args.limit: selected=selected[:args.limit]
    by_name={x['name']:x for x in selected}; fetchers={}
    now=datetime.now(timezone.utc).isoformat()
    for t in selected:
        url=OFFICIAL_PAGES[t['name']]; host=(urlparse(url).hostname or '').lower()
        site='official_'+host.replace('.','_')
        f=fetchers.setdefault(host,PoliteFetcher(site,delay=args.delay,jitter=0.3,timeout=args.timeout,respect_robots=True,max_attempts=args.attempts,allowed_hosts=(host,)))
        rec={'target_id':t['target_id'],'company':t['name'],'country':t['country'],'status':'fetch_failed','source_url':url,'retrieved_at':now,'phones':[],'note':'','official_host':host}
        if not host_ok(url,url): rec['status']='rejected_host'; rec['note']='Configured URL host failed allowlist'; old[t['target_id']]=rec; continue
        html=f.get(url)
        if html is None:
            rec['status']='fetch_failed'; rec['note']='Page unavailable or disallowed by robots.txt; no inference made'
        else:
            phones=extract(html,url)
            for p in phones:
                p.update({'department':'customer support / public contact','locale':'US/CA','source_url':url,'retrieved_at':now})
            rec['phones']=phones
            rec['status']='phone_found' if phones else 'online_only_or_number_not_published'
            if not phones: rec['note']='No public NANP phone number visible on this official page at retrieval time'
        old[t['target_id']]=rec
    # Include untouched targets as explicit pending outcomes for auditability.
    for t in targets:
        if t['target_id'] not in old:
            old[t['target_id']]={'target_id':t['target_id'],'company':t['name'],'country':t['country'],'status':'pending_official_check','source_url':None,'retrieved_at':None,'phones':[],'note':'No official page checked yet'}
    result=[old[t['target_id']] for t in targets]
    OUT.write_text(json.dumps({'schema_version':'1.0','generated_at':now,'records':result,'method':{'official_pages_only':True,'route_claims':False,'robots_respected':True,'third_party_sources_used_for_discovery_only':True}},indent=2,ensure_ascii=False)+'\n',encoding='utf8')
    from collections import Counter
    print(json.dumps({'targets':len(result),'checked':len(selected),'statuses':Counter(x['status'] for x in result),'phones':sum(len(x['phones']) for x in result)},indent=2))
if __name__=='__main__': main()
