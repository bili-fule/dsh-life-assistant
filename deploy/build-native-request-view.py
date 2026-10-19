"""Apply the pinned source extension and build its four native runtime packages.

Usage: python deploy/build-native-request-view.py PATH_TO_PRISTINE_DSH_SOURCE
Requires Node 24+, pnpm, Git and the upstream workspace build dependencies.
Output: native-request-view.tgz in the supplied source directory (never installs).
"""
import hashlib,json,os,shutil,subprocess,sys,tarfile
from pathlib import Path

deploy=Path(__file__).resolve().parent
root=Path(sys.argv[1]).resolve()
pin=json.loads((deploy/'native-request-view.json').read_text(encoding='utf-8'))
for rel,expected in pin['files'].items():
 p=root/rel
 actual=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
 if actual!=expected:raise SystemExit('Source differs from pinned upstream: '+rel)
def run(args,cwd=root):subprocess.run(args,cwd=cwd,check=True)
patch=str(deploy/'native-request-view.patch')
run(['git','apply','--check',patch]);run(['git','apply',patch])
pnpm=shutil.which('pnpm.cmd' if os.name=='nt' else 'pnpm')
if not pnpm:raise SystemExit('pnpm is required')
run([pnpm,'install','--frozen-lockfile','--ignore-scripts'])
run([pnpm,'exec','tsc','-b','packages/core/session','packages/llm/token-meter','packages/compaction/compaction-basic','packages/compaction/compaction-tool-result-pruner','packages/typert/generator','--pretty','false'])
run([pnpm,'exec','vitest','run','packages/core/session/tests/request-view.spec.ts','packages/core/session/tests/surface.spec.ts','packages/core/session/tests/message-projections.spec.ts','packages/llm/token-meter/tests'])
fixture=root/'packages/core/session/tests/yoyo-composition.local.spec.ts'
if fixture.exists():raise SystemExit('Temporary composition test path already exists')
previous=os.environ.get('YOYO_PLUGIN_ROOT')
try:
 fixture.write_bytes((deploy/'native-composition.fixture.mjs').read_bytes())
 os.environ['YOYO_PLUGIN_ROOT']=str(deploy.parent)
 run([pnpm,'exec','vitest','run','packages/core/session/tests/yoyo-composition.local.spec.ts'])
finally:
 fixture.unlink(missing_ok=True)
 if previous is None:os.environ.pop('YOYO_PLUGIN_ROOT',None)
 else:os.environ['YOYO_PLUGIN_ROOT']=previous
run([pnpm,'exec','tsdown','--config','tsdown.config.ts','--filter','@deepseek-ai/dsh-session','--filter','@deepseek-ai/dsh-token-meter','--filter','@deepseek-ai/dsh-compaction-basic','--filter','@deepseek-ai/dsh-compaction-tool-result-pruner','--log-level','warn'])
with tarfile.open(root/'native-request-view.tgz','w:gz') as tar:
 for name,folder in [('dsh-session','packages/core/session'),('dsh-token-meter','packages/llm/token-meter'),('dsh-compaction-basic','packages/compaction/compaction-basic'),('dsh-compaction-tool-result-pruner','packages/compaction/compaction-tool-result-pruner')]:
  tar.add(root/folder/'lib',arcname='@deepseek-ai/'+name+'/lib')
  tar.add(root/'LICENSE',arcname='@deepseek-ai/'+name+'/LICENSE')
 tar.add(deploy/'native-request-view.json',arcname='native-request-view.json')
print('Built '+str(root/'native-request-view.tgz'))
