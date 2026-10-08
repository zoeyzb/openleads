"""Florida official-bar-derived firm roster tests: real URL, count and contact only."""
import tempfile
import unittest
from pathlib import Path
from law_local.florida_roster import (
    ROOT,listing_firms,parse_roster_profile,robots_permits,
    run,add_or_upgrade,ensure_tables,clearly_non_law_employer
)
from law_local.worker import SqliteQueue,evaluate_published_source

URL=ROOT+"/firm/sample-baker-law-pllc"
LIST="""<html><body>
<a href="/firm/sample-baker-law-pllc">Sample Baker Law, PLLC Tampa 3 active attorney s Verified</a>
<a href="/firm/overgrown-attorneys">Overgrown Attorneys 55 active attorney s Verified</a>
<a href="/firm/solo-lawyer">Solo Lawyer, P.A. Miami 1 active attorney s</a>
<a href="/firm/other-firm">Other Firm, LLP 2 active attorney s Verified</a>
<a href="/firm/fifth-firm">Fifth Firm, P.A. 4 active attorney s</a>
<a href="/firm/sixth-firm">Sixth Firm, LLP 6 active attorney s</a>
</body></html>"""
PROFILE="""<html><h1>Sample Baker Law, PLLC</h1>
<div>Attorneys 3 active</div>
<div>Location 1622 North Street Tampa, FL 33601</div>
<div>Phone (813) 277-1144</div>
<h2>Active attorneys (3)</h2>
<div>Jane Baker Active</div><div>Sam Baker Active</div><div>Joe Smith Active</div></html>"""
ROBOTS="""User-Agent: *
Allow: /
Disallow: /search
Disallow: /api/
Sitemap: https://www.floridalawdirectory.com/sitemap.xml
"""

class FloridaRosterTests(unittest.TestCase):
    def test_list_filters_first_without_page_guesses(self):
        a=listing_firms(LIST)
        self.assertEqual(a["all_profiles"],6)
        self.assertEqual(len(a["candidates"]),4)
        self.assertIn((URL,3),a["candidates"])
        self.assertNotIn((ROOT+"/firm/solo-lawyer",1),a["candidates"])
    def test_profile_needs_current_2_to_10_and_published_phone(self):
        lead,status=parse_roster_profile(PROFILE,URL)
        self.assertEqual(status,"size_phone_source_only")
        self.assertEqual((lead["firm"],lead["phone"],lead["published_active_attorneys"]),
                         ("Sample Baker Law, PLLC","8132771144",3))
        d=evaluate_published_source(PROFILE,lead)
        self.assertEqual(d["attorneys"],3)
        self.assertEqual(d["attorney_range"],(3,3))
        bad,_=parse_roster_profile(PROFILE.replace("3 active","1 active"),URL)
        self.assertIsNone(bad)
        none,status=parse_roster_profile(PROFILE.replace("Phone (813) 277-1144",""),URL)
        self.assertIsNone(none)
        self.assertEqual(status,"missing_business_phone")
    def test_non_law_employers_are_not_private_law_practices(self):
        for name in ("A. Duda & Sons, Inc.", "Bayshore Realty Inc",
                     "Orange County Hospital", "Fortune Financial Services"):
            self.assertTrue(clearly_non_law_employer(name),name)
            result,status=parse_roster_profile(
                PROFILE.replace("Sample Baker Law, PLLC",name),URL)
            self.assertIsNone(result)
            self.assertEqual(status,"not_private_firm")
        for name in ("Johnson & Smith, P.A.","Baker Law Group PLLC","Avery & Co., Attorneys"):
            self.assertFalse(clearly_non_law_employer(name),name)

    def test_public_robots_and_source_first_one_page(self):
        with tempfile.TemporaryDirectory() as path:
            def fetch(url,timeout=10):
                if url.endswith("/robots.txt"):return ROBOTS
                if url.endswith("/firms"):return LIST
                if url==URL:return PROFILE
                if url.startswith(ROOT+"/firm/"):
                    return PROFILE.replace("<h1>Sample Baker Law, PLLC</h1>",
                                           "<h1>Office of the State Attorney</h1>")
                raise ValueError("unmocked URL "+url)
            self.assertTrue(robots_permits(fetch))
            report=run(Path(path)/"db.sqlite",max_pages=1,max_profiles=20,
                       seconds=90,fetch_fn=fetch)
            self.assertEqual(report["fl_roster_listings"]["sized_2_to_10_listings"],4)
            self.assertGreaterEqual(report["fl_roster_profiles"]["published_firm_size_phone"],1)
            self.assertEqual(report["counts"].get("pending"),1)
            self.assertEqual(report["counts"].get("calling_qualified"),0)
    def test_versioned_better_public_source_replaces_only_old_failed_proof(self):
        with tempfile.TemporaryDirectory() as path:
            db=SqliteQueue(Path(path)/"db.sqlite")
            ensure_tables(db)
            lead={"firm":"Sample Baker Law, PLLC","phone":"8132771144","state":"FL",
                  "source_url":"https://www.lawyer.com/firm/sample-baker-law-pllc.html"}
            db.add(lead)
            cid=db._id(lead)
            db.conn.execute("UPDATE candidates SET status='unverified_size' WHERE id=?",(cid,))
            db.conn.commit()
            self.assertEqual(add_or_upgrade(db,{**lead,"source_url":URL}),"upgraded_source")
            row=db.conn.execute("SELECT status,source_url FROM candidates WHERE id=?",(cid,)).fetchone()
            self.assertEqual((row["status"],row["source_url"]),("pending",URL))
            db.conn.execute("UPDATE candidates SET status='review_website' WHERE id=?",(cid,))
            db.conn.commit()
            self.assertEqual(add_or_upgrade(db,{**lead,"source_url":URL+"/new"}),"preserved_other_status")
            db.close()
