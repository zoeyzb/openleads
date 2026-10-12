import subprocess,sys,unittest
from pathlib import Path
class ArchiveLaunchTests(unittest.TestCase):
 def test_script_path_imports_law_local(self):
  root=Path(__file__).resolve().parents[2]
  p=subprocess.run([sys.executable,str(root/"ops/local_law/archive_triage.py"),"--help"],cwd=root,capture_output=True,text=True,timeout=15)
  self.assertEqual(p.returncode,0,p.stderr)
  self.assertIn("--max",p.stdout)
