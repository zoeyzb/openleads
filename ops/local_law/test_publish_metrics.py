"""The published primary KPI must never include email-less or unsized calls."""
import json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime,timezone
from ops.local_law import publish_metrics
from law_local.worker import SqliteQueue

class SnapshotQualificationTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  q=SqliteQueue(self.root/'law-leads.sqlite3')
  for status,name,number,count,email in [
        ('strict_eligible','Three Partner Firm','3126661001',3,'business@example.com'),
        ('call_qualified_no_email','Old One-Lawyer Record','3126661002',1,'')]:
   lead={'firm':name,'phone':number,'city':'Chicago','state':'IL','source_url':'https://www.lawyers.com/firm/example'}
   q.add(lead)
   q.record(lead,{'status':status,'site_status':'screened_no_site','phone':number,
      'firm':name,'attorneys':count,'email':email,'email_source':lead['source_url'],
      'headcount_source':lead['source_url'],
      'qualification_scope':'law_no_owned_website_2_10_email',
      'site_evidence':{'providers':[{'responded':True,'urls':['https://www.lawyers.com/firm/example']},
                                    {'responded':True,'urls':['https://www.justia.com/lawyers/example']}]},
      'checked_at':datetime.now(timezone.utc).isoformat()})
  q.close()
 def tearDown(self):self.temp.cleanup()
 def test_primary_qualified_is_strict_exportable_only(self):
  with patch.object(publish_metrics,'ROOT',self.root):
   report=publish_metrics.snapshot()
  self.assertEqual(report['strictQualified'],1)
  self.assertEqual(report['callingQualified'],2)
  self.assertEqual(report['legacyPhoneOnly'],1)
  self.assertNotIn('2–10',report['note'])
 def test_recent_campaign_health_overrides_stale_old_probe(self):
  (self.root/'final-provider-health.log').write_text(json.dumps({'website_search_provider_health':{'status':'degraded'}})+'\n')
  (self.root/'campaign-runs.log').write_text(json.dumps({'time':datetime.now(timezone.utc).isoformat(),
      'verify_exit':0,'site_status':'usable'})+'\n')
  with patch.object(publish_metrics,'ROOT',self.root): report=publish_metrics.snapshot()
  self.assertEqual(report['providerHealth'],'usable')

 def test_legacy_status_without_source_proof_not_counted_as_strict(self):
  db=sqlite3.connect(self.root/'law-leads.sqlite3')
  db.execute("UPDATE candidates SET status='call_qualified_no_email' WHERE status='strict_eligible'")
  db.commit();db.close()
  with patch.object(publish_metrics,'ROOT',self.root): report=publish_metrics.snapshot()
  self.assertEqual(report['strictQualified'],0)

if __name__=='__main__':unittest.main()
