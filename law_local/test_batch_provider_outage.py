import tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from law_local.worker import SqliteQueue,run_batch,utc_now

class BatchOutageTests(unittest.TestCase):
    def test_mid_batch_outage_preserves_remaining_queue(self):
        with tempfile.TemporaryDirectory() as d:
            q=SqliteQueue(Path(d)/'queue.db')
            for i in range(3):
                q.add(dict(firm='Quinn Law '+str(i),phone='312422183'+str(i),state='IL',source_url='https://lawyers.com/quinn'+str(i)))
            result=dict(status='inconclusive',reason='search_provider_unavailable',checked_at=utc_now(),
                        site_evidence={'providers':[dict(provider='searxng:google cse',responded=False,reason='engine_unresponsive')]})
            with patch('law_local.worker.process_candidate',return_value=result) as process, \
                 patch('law_local.worker.apply_verified_bar_contact_proof',side_effect=lambda db,lead,result:result):
                self.assertEqual(run_batch(q,3,1,20),{'inconclusive':1})
                self.assertEqual(process.call_count,1)
            self.assertEqual(q.conn.execute("SELECT count(*) FROM candidates WHERE status='pending'").fetchone()[0],2)
            self.assertEqual(q.conn.execute('SELECT sum(attempts) FROM candidates').fetchone()[0],0)
            q.close()
