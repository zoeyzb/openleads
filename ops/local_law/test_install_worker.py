import unittest
from pathlib import Path
from ops.local_law.install_worker import configuration
class InstallerTests(unittest.TestCase):
 def test_schedule_targets_versioned_module_and_existing_label(self):
  cfg=configuration(Path('/repo'),Path('/data'),Path('/python'))
  self.assertEqual(cfg['ProgramArguments'],['/python','-m','ops.local_law.campaign'])
  self.assertEqual(cfg['WorkingDirectory'],'/repo')
  self.assertEqual(cfg['StartInterval'],3600)
  self.assertEqual(cfg['Label'],'company.recoverrevenue.lawleads')
  self.assertEqual(cfg['EnvironmentVariables']['OPENLEADS_SEARCH_MODE'],'local_forks')

 def test_market_frontier_is_distinct_and_expanded(self):
  from ops.local_law.local_maps_controller import MARKETS
  self.assertEqual(len(MARKETS),len(set(MARKETS)))
  self.assertGreater(len(MARKETS),100)
 def test_scheduler_records_crash_and_propagates_failure(self):
  import tempfile,json
  from unittest.mock import patch
  from ops.local_law import campaign
  with tempfile.TemporaryDirectory() as root,patch.object(campaign,"ROOT",Path(root)),patch.object(campaign,"cycle",side_effect=RuntimeError("fixture")):
   with self.assertRaises(RuntimeError):campaign.scheduled_cycle()
   records=[json.loads(line) for line in (Path(root)/"campaign-runs.log").read_text().splitlines()]
   self.assertEqual([r["event"] for r in records],["cycle_started","cycle_crashed"])
