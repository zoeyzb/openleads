import json
import sqlite3
import tempfile
import unittest
from datetime import datetime,timezone
from pathlib import Path
from ops.local_law.selfhosted_site_pilot import pilot

GOOD={'status':'usable','positive_control_found':True}
BAD={'status':'degraded','positive_control_found':False}

class LocalPilotTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.main=sqlite3.connect(self.root/'law-leads.sqlite3')
        self.main.execute('''CREATE TABLE maps_raw_candidates(map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT,city TEXT,state TEXT,maps_url TEXT,added_at TEXT,status TEXT)''')
        self.main.execute('''CREATE TABLE candidates(phone TEXT,status TEXT)''')
        for i,phone in enumerate(['3124221836','3124221836','2124221836','5124221836']):
            self.main.execute('INSERT INTO maps_raw_candidates VALUES(?,?,?,?,?,?,?,?)',
                              (f'id{i}',f'Example Practice {i}',phone,'Chicago','IL','https://maps.google.com/example','2026-10-01','unverified_headcount'))
        self.main.commit();self.main.close()
    def tearDown(self):self.temp.cleanup()
    @staticmethod
    def found(lead):
        website=lead['firm'].endswith('2')
        result=[]
        for name in ('yandex','yep'):
            result.append({'provider':'searxng:'+name,'responded':True,'urls':[f'https://{lead["firm"].replace(" ","").lower()}.com/'] if website else ['https://www.lawyers.com/example/']})
        return result
    def test_source_only_dedup_and_resume(self):
        first=pilot(self.root,3,search=self.found,health=lambda:GOOD)
        self.assertEqual(first['attempted'],3)
        self.assertEqual(first['review_website'],1)
        self.assertEqual(first['screened_no_site'],2)
        self.assertEqual(first['calling_qualified_added'],0)
        self.assertGreaterEqual(first['skipped_duplicate_phone'],1)
        again=pilot(self.root,3,search=lambda l: (_ for _ in ()).throw(AssertionError('requery')),
                    health=lambda:GOOD)
        self.assertEqual(again['attempted'],0)
        self.assertEqual(again['skipped_recent'],3)
        c=sqlite3.connect(self.root/'research_catalog.sqlite3')
        self.assertEqual(c.execute('SELECT COUNT(*) FROM local_selfhosted_site_checks').fetchone()[0],3)
        self.assertEqual(c.execute('SELECT COUNT(*) FROM local_selfhosted_site_checks WHERE status="review_website"').fetchone()[0],1)
        c.close()
    def test_provider_failure_does_not_touch_private_dbs(self):
        out=pilot(self.root,4,search=lambda l: (_ for _ in ()).throw(AssertionError('no search')),
                  health=lambda:BAD)
        self.assertEqual(out['attempted'],0)
        self.assertFalse((self.root/'research_catalog.sqlite3').exists())
    def test_reject_provider_injection_without_qualifying(self):
        out=pilot(self.root,2,search=lambda lead:[{'provider':'searxng:yep','responded':True,'urls':[]},
                                                  {'provider':'searxng:yep','responded':True,'urls':[]}],health=lambda:GOOD)
        self.assertEqual(out['inconclusive'],2)
        self.assertEqual(out['calling_qualified_added'],0)
    def test_prioritizes_named_private_law_practices(self):
        c=sqlite3.connect(self.root/'law-leads.sqlite3')
        c.execute('INSERT INTO maps_raw_candidates VALUES(?,?,?,?,?,?,?,?)',
                  ('priority','Goodman Law Group PLLC','7134221836','Houston','TX','https://maps.google.com/goodman','2026-10-02','unverified_headcount'))
        c.commit();c.close()
        selected=[]
        def research(lead):
            selected.append(lead['firm'])
            return self.found(lead)
        out=pilot(self.root,1,search=research,health=lambda:GOOD)
        self.assertEqual(out['attempted'],1)
        self.assertEqual(selected,['Goodman Law Group PLLC'])

    def test_offline_reclassification_preserves_provenance_and_caller_queue(self):
        from ops.local_law.selfhosted_site_pilot import reclassify
        c=sqlite3.connect(self.root/'research_catalog.sqlite3')
        c.execute("""CREATE TABLE local_selfhosted_site_checks
           (map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT,checked_at TEXT,status TEXT,evidence_json TEXT)""")
        sources=[{'provider':'searxng:yandex','responded':True,
                  'urls':['https://reviews.birdeye.com/example-law']},
                 {'provider':'searxng:yep','responded':True,
                  'urls':['https://www.lawyers.com/example']}]
        proof={'search_providers':sources,
               'site_signal':{'status':'review_website',
                              'urls':['https://reviews.birdeye.com/example-law']},
               'checked_at':'2026-10-01T10:00:00+00:00'}
        c.execute('INSERT INTO local_selfhosted_site_checks VALUES(?,?,?,?,?,?)',
                  ('a','Example Law','3124221836','2026-10-01T10:00:00+00:00',
                   'review_website',json.dumps(proof)))
        c.commit();c.close()
        outcome=reclassify(self.root)
        self.assertEqual(outcome['changed'],1)
        self.assertEqual(outcome['to_screened_no_site'],1)
        again=reclassify(self.root)
        self.assertEqual(again['changed'],0)
        c=sqlite3.connect(self.root/'research_catalog.sqlite3')
        self.assertEqual(c.execute('SELECT COUNT(*) FROM local_selfhosted_reclass_history').fetchone()[0],1)
        self.assertEqual(c.execute('SELECT checked_at FROM local_selfhosted_site_checks').fetchone()[0],
                         '2026-10-01T10:00:00+00:00')
        c.close()
        m=sqlite3.connect(self.root/'law-leads.sqlite3')
        self.assertEqual(m.execute('SELECT COUNT(*) FROM candidates').fetchone()[0],0)
        m.close()

    def test_bounded_batch(self):
        with self.assertRaises(ValueError):pilot(self.root,100)

if __name__=='__main__':unittest.main()
