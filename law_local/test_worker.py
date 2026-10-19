import unittest
from law_local.worker import (
    normalize_phone, evaluate_published_source, classify_search_results,
    evaluate_candidate, firm_identity_matches, SqliteQueue, import_csv, run_batch
)
import tempfile
from unittest.mock import patch
import csv
from pathlib import Path

PROFILE = """
<html><h1>Keystone & Parker Law Group</h1>
<p>Call (312) 422-1836</p>
<p>Keystone & Parker Law Group has 4 attorneys.</p>
<p>Contact: intake@keystoneparker.testing-law.org</p></html>
"""
LEAD = {
    "firm": "Keystone & Parker Law Group",
    "phone": "(312) 422-1836",
    "city": "Chicago", "state": "IL",
    "source_url": "https://www.lawyers.com/chicago/illinois/keystone-parker-law-group/"
}

class PublicDirectoryRecognitionTests(unittest.TestCase):
    def test_new_public_directory_domains_never_imply_owned_site(self):
        rows=[{'responded':True,'urls':['https://www.allbiz.com/business/example-law']},
              {'responded':True,'urls':['https://www.lawyerdb.org/lawfirm/example']}]
        self.assertEqual(classify_search_results(rows)['status'],'screened_no_site')

class ThirdPartySiteResearchTests(unittest.TestCase):
    def test_public_legal_and_business_indexes_are_not_firm_owned_websites(self):
        hosts=('birdeye.com','bizapedia.com','findglocal.com','allusinjurylawyers.com',
               'reliaguide.com','attorneyhelp.org','localsolution.com','law-db.mc.edu',
               'infoattorneys.com','experience.com','nextdoor.com','issuu.com',
               'bnimidsouth.com','attorneyslisted.com','globallawlists.org',
               'yobi.com','us-info.com','evvbar.org','lawyerland.com',
               'gadsdenmessenger.com','gadsdenthrive.com')
        for hostname in hosts:
            with self.subTest(hostname=hostname):
                result=classify_search_results([
                    {'responded':True,'urls':['https://'+hostname+'/business/example-law']},
                    {'responded':True,'urls':['https://www.lawyers.com/firm/example']}])
                self.assertEqual(result['status'],'screened_no_site')

    def test_dedicated_hosted_and_likely_firm_domains_still_need_review(self):
        for url in ('https://thelawteam.net/',
                    'https://elderlawsanangelo.wordpress.com/about/'):
            with self.subTest(url=url):
                result=classify_search_results([
                    {'responded':True,'urls':[url]}, {'responded':True,'urls':[]}])
                self.assertEqual(result['status'],'review_website')

class EvidenceRetentionTests(unittest.TestCase):
    def test_inactive_hold_survives_automatic_retry(self):
        import json
        with tempfile.TemporaryDirectory() as d:
            q=SqliteQueue(Path(d)/"q.db")
            q.add(LEAD)
            hold={"status":"rejected_inactive","eligibility_hold":{"reason":"retired"}}
            q.record(LEAD,hold)
            q.record(LEAD,{"status":"inconclusive","reason":"search_provider_unavailable"})
            row=q.conn.execute("SELECT status,result_json FROM candidates").fetchone()
            self.assertEqual(row["status"],"rejected_inactive")
            self.assertEqual(json.loads(row["result_json"])["eligibility_hold"],hold["eligibility_hold"])
            q.close()

    def test_owned_site_hold_survives_automatic_retry(self):
        import json
        with tempfile.TemporaryDirectory() as d:
            q=SqliteQueue(Path(d)/"q.db");q.add(LEAD)
            q.record(LEAD,{"status":"review_website","owned_site_url":"https://firm.example/"})
            q.record(LEAD,{"status":"inconclusive","reason":"search_provider_unavailable"})
            self.assertEqual(json.loads(q.conn.execute("SELECT result_json FROM candidates").fetchone()[0])["owned_site_url"],"https://firm.example/")
            q.close()

    def test_unresolved_website_candidates_survive_outage(self):
        import json
        with tempfile.TemporaryDirectory() as d:
            q=SqliteQueue(Path(d)/"q.db");q.add(LEAD)
            hold={"status":"review_website","website_candidates":["https://possible.example/"]}
            q.record(LEAD,hold)
            q.record(LEAD,{"status":"inconclusive","reason":"search_provider_unavailable"})
            self.assertEqual(json.loads(q.conn.execute("SELECT result_json FROM candidates").fetchone()[0]),hold)
            q.close()

    def test_nonlaw_evidence_revokes_verified_practice(self):
        from law_local.worker import utc_now
        for status in ("review_nonlaw_employer","owned_site_or_untrusted_source"):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as d:
                q=SqliteQueue(Path(d)/"q.db");q.add(LEAD)
                q.record(LEAD,{"status":"call_qualified_no_email","phone":LEAD["phone"],"checked_at":utc_now(),"site_status":"screened_no_site","qualification_scope":"law_no_owned_website_2_10_phone","attorneys":4,"headcount_source":LEAD["source_url"],"site_evidence":{"providers":[{"responded":True},{"responded":True}]}})
                self.assertEqual(q.counts()["calling_qualified"],1)
                q.record(LEAD,{"status":status})
                self.assertEqual(q.counts()["calling_qualified"],0)
                q.close()

    def test_verified_review_survives_provider_outage(self):
        import json
        from law_local.worker import utc_now
        with tempfile.TemporaryDirectory() as d:
            q=SqliteQueue(Path(d)/"q.db");q.add(LEAD)
            proof={"status":"call_qualified_no_email","firm":LEAD["firm"],"phone":LEAD["phone"],"checked_at":utc_now(),"site_status":"screened_no_site","qualification_scope":"law_no_owned_website_2_10_phone","attorneys":4,"headcount_source":LEAD["source_url"],"site_evidence":{"providers":[{"responded":True},{"responded":True}]}}
            q.record(LEAD,proof)
            q.record(LEAD,{"status":"inconclusive","reason":"search_provider_unavailable"})
            row=q.conn.execute("SELECT status,result_json FROM candidates").fetchone()
            self.assertEqual(row["status"],"call_qualified_no_email")
            self.assertEqual(json.loads(row["result_json"])["checked_at"],proof["checked_at"])
            q.record(LEAD,{"status":"rejected_inactive","eligibility_hold":{"reason":"retired"}})
            self.assertEqual(q.counts()["calling_qualified"],0)
            q.close()

class QueuePriorityTests(unittest.TestCase):
    def test_official_firm_size_source_first(self):
        with tempfile.TemporaryDirectory() as root:
            queue=SqliteQueue(Path(root)/"queue.sqlite")
            try:
                for firm,url,phone in [
                    ("Example First Firm","https://www.floridalawdirectory.com/firm/example", "3124221836"),
                    ("Evidence Firm", "https://www.inbar.org/member/real", "3177731974")]:
                    self.assertTrue(queue.add({"firm":firm,"phone":phone,"city":"","state":"IN","source_url":url}))
                self.assertEqual(queue.pending(1)[0]["firm"],"Evidence Firm")
                self.assertEqual(queue.counts()["calling_qualified"],0)
            finally:queue.close()

class QualityTests(unittest.TestCase):
    def test_phone(self):
        self.assertEqual(normalize_phone("+1 (312) 422-1836"), "3124221836")
        self.assertEqual(normalize_phone("111-111-1111"), "")
        self.assertEqual(normalize_phone("000-000-0000"), "")
        self.assertEqual(normalize_phone("312-555-0182"), "")

    def test_firm_identity_requires_name_and_phone(self):
        self.assertTrue(firm_identity_matches(PROFILE, LEAD))
        self.assertFalse(firm_identity_matches(PROFILE.replace("422-1836","422-1111"), LEAD))
        self.assertFalse(firm_identity_matches(PROFILE.replace("Keystone & Parker","Someone Else"), LEAD))

    def test_headcount_and_email_are_attested_by_same_page(self):
        result=evaluate_published_source(PROFILE, LEAD)
        self.assertEqual(result["attorneys"],4)
        self.assertEqual(result["emails"],["intake@keystoneparker.testing-law.org"])
        self.assertFalse(result["website_candidates"])

    def test_explicit_directory_firm_size_field(self):
        html=PROFILE.replace("Keystone & Parker Law Group has 4 attorneys.","Firm Size: 4")
        self.assertEqual(evaluate_published_source(html,LEAD)["attorneys"],4)

    def test_office_size_range_is_not_firmwide_proof(self):
        html=PROFILE.replace("Keystone & Parker Law Group has 4 attorneys.", "Office Size: 2-5 attorneys")
        self.assertEqual(evaluate_published_source(html,LEAD)["attorneys"],0)

    def test_directory_footer_email_is_not_a_firm_email(self):
        html=PROFILE.replace("intake@keystoneparker.testing-law.org",
                             "support@corp.lawyer.com")
        result=evaluate_published_source(html,LEAD)
        self.assertEqual(result["emails"],[])

    def test_relative_visit_site_link_requires_manual_review(self):
        html=PROFILE.replace("</html>","<a href='/out?firm=123'>Visit Site</a></html>")
        result=evaluate_candidate(LEAD,html,[
            {"responded":True,"urls":[]},{"responded":True,"urls":[]}
        ],mx_check=lambda domain:True)
        self.assertEqual(result["status"],"review_website")
        self.assertTrue(result["website_candidates"])

    def test_local_office_count_is_not_firmwide_size(self):
        html=PROFILE.replace("has 4 attorneys.", "has 4 attorneys at this location.")
        self.assertEqual(evaluate_published_source(html,LEAD)["attorneys"],0)
        firmwide=PROFILE.replace("has 4 attorneys.","has 4 attorneys.")
        self.assertEqual(evaluate_published_source(firmwide,LEAD)["attorneys"],4)

    def test_reject_unattributed_headcount(self):
        html=PROFILE.replace("Keystone & Parker Law Group has 4 attorneys.","4 attorneys for defendant.")
        self.assertEqual(evaluate_published_source(html,LEAD)["attorneys"],0)

    def test_positive_site_detected_even_if_second_provider_is_down(self):
        found=classify_search_results([
            {"responded":True,"urls":["https://example-firm-owned-domain.org/contact"]},
            {"responded":False,"urls":[]}])
        self.assertEqual(found["status"],"review_website")

    def test_missing_email_never_qualifies(self):
        html=PROFILE.replace("intake@keystoneparker.testing-law.org","")
        verdict=evaluate_candidate(LEAD,html,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],mx_check=lambda domain:False)
        self.assertEqual(verdict["status"],"call_qualified_no_email")

    def test_search_index_noise_does_not_count_as_firm_match(self):
        from law_local.worker import search_result_relevant
        self.assertFalse(search_result_relevant("The - Wikipedia", "definition of the", LEAD))
        self.assertFalse(search_result_relevant("Help on Windows - Microsoft", "Microsoft support", LEAD))
        self.assertTrue(search_result_relevant("Keystone & Parker Law Group profile",
                                               "Chicago attorneys", LEAD))

    def test_ddg_query_echo_and_navigation_never_count_as_results(self):
        from law_local.worker import _ddg_result_links
        html='<html>duckduckgo Keystone & Parker Law Group <a href="https://random-lawyer.com">Keystone & Parker Law Group</a><div class="result__a">Keystone & Parker Law Group</div></html>'
        self.assertEqual(_ddg_result_links(html,LEAD),[])

    def test_ddg_real_result_requires_matching_title_and_unwraps_redirect(self):
        from law_local.worker import _ddg_result_links
        html='<html>duckduckgo <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkeystoneparker.org%2Fcontact">Keystone &amp; Parker Law Group</a><a class="result__a" href="https://unrelated.example.org/">Unrelated Lawyers</a></html>'
        self.assertEqual(_ddg_result_links(html,LEAD),['https://keystoneparker.org/contact'])

    def test_search_outage_does_not_certify_absence(self):
        found=classify_search_results([{"responded":False,"urls":[]},{"responded":True,"urls":[]}])
        self.assertEqual(found["status"],"inconclusive")

    def test_two_clean_search_responses_support_bounded_audit(self):
        found=classify_search_results([{"responded":True,"urls":["https://www.lawyers.com/profile"]},{"responded":True,"urls":["https://www.justia.com/attorneys"]}])
        self.assertEqual(found["status"],"screened_no_site")

    def test_possible_firm_site_must_be_reviewed(self):
        found=classify_search_results([{"responded":True,"urls":["https://keystoneparker.testing-law.org"]},{"responded":True,"urls":[]}])
        self.assertEqual(found["status"],"review_website")

    def test_ddg_redirect_cannot_hide_possible_owned_website(self):
        found=classify_search_results([
            {"responded":True,"urls":["https://duckduckgo.com/l/?uddg=https%3A%2F%2Fkeystoneparker.testing-law.org"]},
            {"responded":True,"urls":[]}
        ])
        self.assertEqual(found["status"],"review_website")

    def test_missing_bing_source_does_not_make_verified(self):
        found=classify_search_results([
            {"responded":False,"urls":[]},
            {"responded":True,"urls":[]}
        ])
        self.assertNotEqual(found["status"],"screened_no_site")

    def test_firm_owned_source_page_cannot_be_no_site(self):
        lead={**LEAD,"source_url":"https://keystoneparker.testing-law.org/about"}
        verdict=evaluate_candidate(lead,PROFILE,[
            {"responded":True,"urls":[]},{"responded":True,"urls":[]}
        ],mx_check=lambda domain:True)
        self.assertEqual(verdict["status"],"owned_site_or_untrusted_source")

    def test_strict_gate_never_guesses_an_email(self):
        result=evaluate_candidate(LEAD, PROFILE.replace("intake@keystoneparker.testing-law.org",""),
                                  [{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                                  mx_check=lambda domain:True)
        self.assertEqual(result["status"],"call_qualified_no_email")
        self.assertEqual(result["email"],"")

    def test_published_email_qualifies_regardless_of_firm_size(self):
        for wording in ('Keystone & Parker Law Group has 1 attorney.',
                        'Keystone & Parker Law Group has 24 attorneys.',
                        'The attorneys at this location have 4 members.'):
            with self.subTest(wording=wording):
                html=PROFILE.replace('Keystone & Parker Law Group has 4 attorneys.',wording)
                result=evaluate_candidate(LEAD,html,[{'responded':True,'urls':[]},
                              {'responded':True,'urls':[]}],mx_check=lambda domain:True)
                self.assertEqual(result['status'],'strict_eligible')

    def test_strict_gate_requires_mx_and_two_no_site_checks(self):
        good=evaluate_candidate(LEAD,PROFILE,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                                mx_check=lambda domain:True)
        self.assertEqual(good["status"],"strict_eligible")
        bad=evaluate_candidate(LEAD,PROFILE,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                               mx_check=lambda domain:False)
        self.assertEqual(bad["status"],"call_qualified_no_email")
        self.assertEqual(bad["email"],"")

    def test_fl_active_roster_count_is_not_firmwide_size(self):
        lead={**LEAD,"firm":"Abrahamson & Uiterwyk Injury Lawyers",
              "phone":"7277259411",
              "source_url":"https://www.floridalawdirectory.com/firm/abrahamson-uiterwyk-injury-lawyers"}
        page="<h1>Abrahamson & Uiterwyk Injury Lawyers</h1><p>727-725-9411</p><p>Attorneys 5 active</p>"
        result=evaluate_candidate(lead,page,[{"responded":True,"urls":[]},
                              {"responded":True,"urls":[]}],lambda domain:True)
        self.assertEqual(result["status"],"call_qualified_no_email")
        self.assertEqual(result["attorneys"],0)

    def test_owned_site_hint_still_trumps_fl_size_scope(self):
        lead={**LEAD,"firm":"Abrahamson & Uiterwyk Injury Lawyers",
              "phone":"7277259411",
              "source_url":"https://www.floridalawdirectory.com/firm/abrahamson-uiterwyk-injury-lawyers"}
        page=("<h1>Abrahamson & Uiterwyk Injury Lawyers</h1>"
              "<p>727-725-9411</p><p>Attorneys 5 active</p>"
              '<a href="https://www.theinjurylawyers.com/">Visit Website</a>')
        result=evaluate_candidate(lead,page,[],lambda domain:True)
        self.assertEqual(result["status"],"review_website")

    def test_size_holds_are_not_reopened_without_new_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            filename=Path(folder)/"law.sqlite3"
            db=SqliteQueue(filename);db.add(LEAD)
            db.record(LEAD,{"status":"review_headcount_scope","reason":"old policy"})
            db.close()
            db=SqliteQueue(filename)
            self.assertEqual(db.counts().get("review_headcount_scope"),1)
            self.assertEqual(db.counts()["calling_qualified"],0)
            db.close()

    def test_queue_persists_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"law.sqlite3"
            db=SqliteQueue(path)
            self.assertTrue(db.add(LEAD))
            self.assertFalse(db.add(LEAD))
            self.assertEqual(len(db.pending(10)),1)
            db.record(LEAD,{"status":"strict_eligible","attorneys":4,"email":"intake@keystoneparker.testing-law.org"})
            db.close()
            db=SqliteQueue(path)
            self.assertEqual(len(db.pending(10)),0)
            self.assertEqual(db.counts()["stored_strict_labels"],1)
            db.close()

    def test_provider_outage_preserves_retry_budget_and_cools_down(self):
        from datetime import datetime, timezone, timedelta
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            db.add(LEAD)
            outage={"status":"inconclusive","site_evidence":
                    {"status":"inconclusive","reason":"search_provider_unavailable"}}
            db.record(LEAD,outage)
            row=db.conn.execute("SELECT attempts FROM candidates").fetchone()
            self.assertEqual(row["attempts"],0)
            self.assertEqual(db.pending(10),[])
            old=(datetime.now(timezone.utc)-timedelta(hours=7)).isoformat(timespec="seconds")
            db.conn.execute("UPDATE candidates SET updated=?",(old,))
            db.conn.commit()
            self.assertEqual(len(db.pending(10)),1)
            db.record(LEAD,{"status":"inconclusive","reason":"source_fetch_failed"})
            self.assertEqual(db.conn.execute("SELECT attempts FROM candidates").fetchone()["attempts"],1)
            db.close()

    def test_phone_only_record_is_call_eligible_not_email_eligible(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            self.assertTrue(db.add(LEAD))
            from datetime import datetime,timezone
            db.record(LEAD,{"status":"call_qualified_no_email","attorneys":4,
                "phone":"3124221836","headcount_source":LEAD["source_url"],
                "site_status":"screened_no_site", "qualification_scope":"law_no_owned_website_2_10_email",
                "site_evidence":{"providers":[{"responded":True,"urls":[]},{"responded":True,"urls":[]}]},
                "checked_at":datetime.now(timezone.utc).isoformat()})
            self.assertEqual(db.counts()["calling_qualified"],1)
            self.assertEqual(db.counts().get("strict_eligible",0),0)
            export_path=Path(folder)/"call.csv"
            self.assertEqual(db.export("calling_qualified",export_path),1)
            db.close()

    def test_unreported_firmwide_size_does_not_block_phone_lane(self):
        page=PROFILE.replace("Keystone & Parker Law Group has 4 attorneys.","")
        result=evaluate_candidate(LEAD,page,[{"provider":"fixture-one","responded":True,"urls":[]},
             {"provider":"fixture-two","responded":True,"urls":[]}],lambda domain:False)
        self.assertEqual(result["status"],"call_qualified_no_email")
        self.assertEqual(result["attorneys"],0)
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            db.add(LEAD);db.record(LEAD,result)
            self.assertEqual(db.counts()["calling_qualified"],1)
            db.close()

    def test_export_does_not_trust_status_without_verified_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            db.add(LEAD)
            db.record(LEAD,{"status":"call_qualified_no_email","attorneys":4})
            self.assertEqual(db.counts()["calling_qualified"],0)
            self.assertEqual(db.export("calling_qualified",Path(folder)/"calls.csv"),0)
            db.close()

    def test_degraded_site_provider_defers_without_consuming_queue(self):
        from law_local.worker import run_batch
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            db.add(LEAD)
            before=db.conn.execute("SELECT status,attempts,result_json FROM candidates").fetchone()
            result=run_batch(db,max_rows=10,workers=1,seconds=5,site_search_usable=False)
            after=db.conn.execute("SELECT status,attempts,result_json FROM candidates").fetchone()
            self.assertEqual(result,{"blocked_website_provider":1})
            self.assertEqual(tuple(before),tuple(after))
            db.close()

    def test_export_rejects_disagreement_between_status_and_evidence(self):
        from law_local.worker import utc_now
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            db.add(LEAD)
            db.record(LEAD,{"status":"call_qualified_no_email",
                "phone":"3124221836","checked_at":utc_now(),
                "site_status":"screened_no_site",
                "qualification_scope":"law_no_owned_website_2_10_phone","attorneys":4,"headcount_source":LEAD["source_url"],
                "site_evidence":{"providers":[{"responded":True},{"responded":True}]}})
            # Simulate a stale evidence payload after a database status change.
            db.conn.execute("UPDATE candidates SET status='strict_eligible'")
            db.conn.commit()
            self.assertEqual(db.counts()["calling_qualified"],0)
            out=Path(folder)/"calls.csv"
            self.assertEqual(db.export("calling_qualified",out),0)
            with out.open() as handle:
                self.assertEqual(list(csv.DictReader(handle)),[])
            db.close()

    def test_shared_phone_aliases_export_once_preferring_verified_email(self):
        from law_local.worker import utc_now
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            aliases=[LEAD,{**LEAD,"firm":"Keystone Parker Law LLC"}]
            for lead,status in zip(aliases,("call_qualified_no_email","strict_eligible")):
                db.add(lead)
                proof={"status":status,"phone":"3124221836","checked_at":utc_now(),
                    "site_status":"screened_no_site",
                    "qualification_scope":"law_no_owned_website_2_10_phone","attorneys":4,"headcount_source":LEAD["source_url"],
                    "site_evidence":{"providers":[{"responded":True},{"responded":True}]}}
                if status=="strict_eligible":
                    proof.update(email="office@keystoneparker.example",
                                 attorneys=4,
                                 headcount_source=lead["source_url"],
                                 qualification_scope="law_no_owned_website_2_10_email",
                                 email_source=lead["source_url"])
                db.record(lead,proof)
            self.assertEqual(db.counts()["calling_qualified"],1)
            out=Path(folder)/"calls.csv"
            self.assertEqual(db.export("calling_qualified",out),1)
            with out.open() as handle:
                exported=list(csv.DictReader(handle))
            self.assertEqual([row["Firm"] for row in exported],["Keystone Parker Law LLC"])
            db.close()

    def test_legacy_no_email_records_are_requeued(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"law.sqlite3"
            db=SqliteQueue(path)
            db.add(LEAD)
            db.record(LEAD,{"status":"call_ready_no_email","attorneys":4})
            db.close()
            db=SqliteQueue(path)
            self.assertEqual(db.counts()["pending"],1)
            db.close()

class EndToEndTests(unittest.TestCase):
    def test_outage_is_not_retried_three_times_in_one_run(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            self.assertTrue(db.add(LEAD))
            with patch("law_local.worker.fetch_public",side_effect=TimeoutError("source timeout")):
                result=run_batch(db,max_rows=5,workers=1,seconds=10)
            self.assertEqual(result,{"inconclusive":1})
            self.assertEqual(db.conn.execute("SELECT attempts FROM candidates").fetchone()[0],1)
            db.close()

    def test_cli_outage_still_checks_source_but_never_qualifies(self):
        from law_local.worker import main
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"law.sqlite3"
            db=SqliteQueue(path)
            self.assertTrue(db.add(LEAD))
            db.close()
            with patch("law_local.site_provider_health.audit_provider_health",
                       return_value={"status":"degraded","responded":0,
                                     "positive_control_found":False}):
                with patch("law_local.worker.fetch_public",return_value=PROFILE):
                    with patch("law_local.worker.search_for_firm",side_effect=AssertionError("site provider should not run")):
                        main(["--db",str(path),"run","--max","1"])
            db=SqliteQueue(path)
            record=db.conn.execute("SELECT status,attempts FROM candidates").fetchone()
            self.assertNotIn(record["status"],("strict_eligible","call_qualified_no_email"))
            self.assertEqual(record["attempts"],0)  # provider outage is not a firm failure
            db.close()

    def test_florida_roster_only_batch_requires_known_owned_site_control(self):
        from law_local.worker import main
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"law.sqlite3"
            lead={**LEAD,"source_url":"https://floridalawdirectory.com/firm/example-law/"}
            db=SqliteQueue(path)
            self.assertTrue(db.add(lead))
            db.close()
            with patch("law_local.site_provider_health.audit_provider_health",
                       return_value={"status":"degraded","responded":0,
                                     "positive_control_found":False}) as health:
                with patch("law_local.worker.fetch_public",return_value=PROFILE):
                    with patch("law_local.worker.search_for_firm",side_effect=AssertionError("no site search without positive control")):
                        main(["--db",str(path),"run","--max","1"])
            health.assert_called_once()
            db=SqliteQueue(path)
            row=db.conn.execute("SELECT status,attempts FROM candidates").fetchone()
            self.assertEqual(row["status"],"pending")
            self.assertEqual(row["attempts"],0)
            self.assertEqual(db.counts()["calling_qualified"],0)
            db.close()

    def test_import_process_export_source_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            path=Path(folder)/"seeds.csv"
            with path.open("w",newline="",encoding="utf-8") as file:
                w=csv.DictWriter(file,fieldnames=["firm","phone","city","state","source_url"])
                w.writeheader()
                w.writerow(LEAD)
            self.assertEqual(import_csv(db,path),1)
            with patch("law_local.worker.fetch_public",return_value=PROFILE), \
                 patch("law_local.worker.search_for_firm",return_value=[
                     {"provider":"fixture-one","responded":True,"urls":[]},{"provider":"fixture-two","responded":True,"urls":[]}
                 ]), \
                 patch("law_local.worker.domain_has_mail",return_value=True), \
                 patch("law_local.worker.email_domain_websites",return_value=[]):
                result=run_batch(db,max_rows=1,workers=1,seconds=10)
            self.assertEqual(result,{"strict_eligible":1})
            output=Path(folder)/"strict.csv"
            self.assertEqual(db.export("strict_eligible",output),1)
            with output.open(newline="",encoding="utf-8") as file:
                rows=list(csv.DictReader(file))
            self.assertEqual(rows[0]["Headcount source"],LEAD["source_url"])
            self.assertEqual(rows[0]["Email source"],LEAD["source_url"])
            self.assertEqual(rows[0]["Website audit"],"screened_no_site")
            self.assertEqual(db.counts()["stored_strict_labels"],1)
            db.close()

if __name__=="__main__":
    unittest.main()
