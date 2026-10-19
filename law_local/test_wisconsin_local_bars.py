"""Source cards must bind one published WI practice, phone, email and valid term."""
import unittest
import tempfile
from datetime import date
from pathlib import Path
from law_local.worker import SqliteQueue
from law_local.wisconsin_local_bars import URL, parse_cards, scoped_contact, ingest

def card(firm,person,phone,email,term='1/1/2026-12/31/2026'):
    return (f'<div class="Item col-12 col-md-6"><h2 class="Title">Contact</h2>'
            f"<div class='Body'><ul><li class='Name'>Atty. {person}</li>"
            f"<li class='Company'>{firm}</li><li class='CityStateZip'>Madison, WI 53701</li>"
            f"<li class='Phone'><strong>Phone: </strong>{phone}</li>"
            f"<li class='Email'><strong>Email: </strong> <a href='mailto:{email}'>{email}</a></li>"
            f"<li class='Term'>Term: {term}</li></ul></div></div>")

PAGE=('<html>'+card('Sauer & Rivera Law Offices LLC','Janice Doe','(608) 333-7700',
                    'janice@gmail.com')+
      card('Benson Law Group PLLC','James Smith','608-333-7799','benson@bensonlaw.com')+
      card('State Public Defender','Public Person','608-333-7000','public@gov.wi.gov')+
      card('Columbia County District Attorneys Office','County Prosecutor','608-333-7011','district@gov.wi.gov')+
      card('Historic Law Office','Retired Person','608-333-7111','retired@gmail.com',
           '1/1/2020-12/31/2020')+'</html>')

class WisconsinContactTests(unittest.TestCase):
    def test_distinct_contact_cards_and_current_private_practice(self):
        rows=parse_cards(PAGE,clock=date(2026,10,19))
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['email'],'janice@gmail.com')
        self.assertEqual(rows[0]['phone'],'6083337700')
        self.assertEqual(rows[1]['email'],'benson@bensonlaw.com')
    def test_canonical_source_verifier_only_uses_email_from_matched_wisconsin_card(self):
        from law_local.worker import evaluate_published_source
        lead=dict(firm='Sauer & Rivera Law Offices LLC',phone='6083337700',
                  source_url=URL,state='WI')
        result=evaluate_published_source(PAGE,lead)
        self.assertEqual(result['emails'],['janice@gmail.com'])
        self.assertTrue(result['scoped_contact_matched'])
        mismatched={**lead,'firm':'Wrong Practice'}
        self.assertFalse(evaluate_published_source(PAGE,mismatched)['emails'])
    def test_other_firm_email_cannot_be_attributed_to_matching_phone(self):
        match=scoped_contact(PAGE,'Sauer & Rivera Law Offices LLC','6083337700',
                             clock=date(2026,10,19))
        self.assertEqual(match['emails'],['janice@gmail.com'])
        self.assertEqual(match['website_candidates'],[])
        self.assertFalse(scoped_contact(PAGE,'Sauer & Rivera Law Offices LLC',
                                        '6083337799',clock=date(2026,10,19)))
    def test_public_roster_ingest_is_research_only_and_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            q=SqliteQueue(Path(td)/'law.db')
            fetch=lambda url,timeout=12: 'User-agent: *\nAllow: /\n' if url.endswith('robots.txt') else PAGE
            one=ingest(q,fetch=fetch,clock=date(2026,10,19))
            self.assertEqual(one['candidates_added'],2)
            self.assertEqual(q.counts()['strict_eligible'],0)
            second=ingest(q,fetch=lambda *a,**k: (_ for _ in ()).throw(
                AssertionError('successful roster fetch must cool down')),
                clock=date(2026,10,19))
            self.assertEqual(second['candidates_added'],0)
            self.assertEqual(second['reason'],'daily_source_cooldown')
            q.close()
    def test_disallowed_robots_blocks_collection(self):
        with tempfile.TemporaryDirectory() as td:
            q=SqliteQueue(Path(td)/'law.db')
            fetch=lambda url,timeout=12:'User-agent: *\nDisallow: /\n' if url.endswith('robots.txt') else PAGE
            got=ingest(q,fetch=fetch,clock=date(2026,10,19))
            self.assertEqual(got['reason'],'robots_disallowed')
            self.assertEqual(q.counts().get('pending',0),0)
            q.close()

if __name__=='__main__':unittest.main()
