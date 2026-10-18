"""Install the canonical hourly Mac worker; no copied controller or new service."""
import os,plistlib,subprocess,sys
from pathlib import Path
LABEL="company.recoverrevenue.lawleads"

def configuration(repo,root,python):
 return {"Label":LABEL,"ProgramArguments":[str(python),"-m","ops.local_law.campaign"],
  "WorkingDirectory":str(repo),"StartInterval":3600,"RunAtLoad":True,
  "EnvironmentVariables":{"OPENLEADS_SEARCH_MODE":"local_forks",
       "PATH":"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
  "StandardOutPath":str(root/"launch-out.log"),
  "StandardErrorPath":str(root/"launch-error.log"),"ProcessType":"Background"}

def main():
 if sys.platform!="darwin":raise SystemExit("Mac launchd installer only")
 repo=Path(__file__).resolve().parents[2];root=Path.home()/"lead-workspace"
 target=Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
 target.parent.mkdir(parents=True,exist_ok=True)
 backup=root/"backups/strict-repair-20261018";backup.mkdir(parents=True,exist_ok=True)
 if target.exists() and not (backup/target.name).exists():
  (backup/target.name).write_bytes(target.read_bytes())
 config=configuration(repo,root,sys.executable)
 temp=target.with_suffix(".tmp");temp.write_bytes(plistlib.dumps(config));os.replace(temp,target)
 domain="gui/"+str(os.getuid())
 subprocess.run(["launchctl","bootout",domain+"/"+LABEL],capture_output=True)
 subprocess.run(["launchctl","bootstrap",domain,str(target)],check=True)
 subprocess.run(["launchctl","print",domain+"/"+LABEL],check=True)
if __name__=="__main__":main()
