import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from ops.local_law.reconcile_maps_contact_conflict import quarantine


class MapsPhoneConflictTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)/'law.sqlite3'
        with sqlite3.connect(self.path) as c:
            c.execute('CREATE TABLE maps_raw_candidates(map_id TEXT, firm TEXT, phone TEXT)')
            c.execute('CREATE TABLE maps_website_checks(map_id TEXT, checked_at TEXT,status TEXT,result_json TEXT)')
            c.execute('INSERT INTO maps_raw_candidates VALUES(?,?,?)',('alias|8156258200','Elizabeth Schauff','8156258200'))
            c.execute('INSERT INTO maps_website_checks VALUES(?,?,?,?)',(
                'alias|8156258200','2026-10-17T13:00:00+00:00','screened_no_site',
                json.dumps({'providers':[{'provider':'searxng:yandex','responded':True}]})))
        self.kw = {'map_id':'alias|8156258200','owner_name':'Ward Murray Pace Johnson',
                   'owned_url':'https://www.wmpj.com/contact/',
                   'html':'<h1>Ward Murray Pace Johnson</h1><p>Phone: (815) 625-8200</p>'}
    def tearDown(self):self.tmp.cleanup()
    def test_preserves_original_evidence_and_does_not_duplicate(self):
        result=quarantine(self.path,**self.kw)
        self.assertTrue(result['changed'])
        self.assertTrue(quarantine(self.path,**self.kw)['idempotent'])
        with sqlite3.connect(self.path) as c:
            result=c.execute('SELECT status,result_json FROM maps_website_checks').fetchone()
            self.assertEqual(result[0],'manual_followup_required')
            self.assertEqual(json.loads(result[1])['conflict_kind'],'other_practice_owned_site_shares_phone')
            original=c.execute('SELECT previous_status,previous_result_json FROM maps_site_conflict_history').fetchall()
            self.assertEqual(len(original),1)
            self.assertEqual(original[0][0],'screened_no_site')
            self.assertIn('searxng:yandex',original[0][1])
    def test_other_phone_or_missing_owner_or_directory_cannot_change_record(self):
        for kw in ({'html':'Ward Murray Pace Johnson Phone: (815) 625-8201'},
                   {'html':'Unrelated law firm Phone: (815) 625-8200'},
                   {'owned_url':'https://lawtally.com/lawyers/ward-murray'},
                   {'owned_url':'https://www.wmpj.com/contact/','owner_name':'Other Firm'}):
            with self.subTest(kw=kw),self.assertRaises(ValueError):
                quarantine(self.path,**{**self.kw,**kw})
        with sqlite3.connect(self.path) as c:
            self.assertEqual(c.execute('SELECT status FROM maps_website_checks').fetchone()[0],'screened_no_site')

if __name__=='__main__':unittest.main()
