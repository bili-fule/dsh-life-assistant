"""Dedicated bridge: containers can reach ONLY the fixed host model proxy."""
import subprocess,json
def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True)
try:network=json.loads(run('docker','network','inspect','yoyo-debug').stdout)[0]
except subprocess.CalledProcessError:
 run('docker','network','create','--driver','bridge','--subnet','172.31.254.0/28','--gateway','172.31.254.1','--opt','com.docker.network.bridge.name=br-yoyo-debug','yoyo-debug')
 network=json.loads(run('docker','network','inspect','yoyo-debug').stdout)[0]
if network['Options'].get('com.docker.network.bridge.name')!='br-yoyo-debug' or network['IPAM']['Config'][0]['Subnet']!='172.31.254.0/28':raise RuntimeError('Existing debug network differs')
rules=[['INPUT','-i','br-yoyo-debug','-p','tcp','--dport','3190','-d','172.31.254.1','-j','ACCEPT'],['INPUT','-i','br-yoyo-debug','-j','DROP'],['DOCKER-USER','-i','br-yoyo-debug','-j','DROP']]
# Insert drop first and allow last, so no temporary broad allow exists.
for rule in reversed(rules):
 if subprocess.run(['iptables','-C',*rule],capture_output=True).returncode:run('iptables','-I',rule[0],'1',*rule[1:])
print('debug containers: model proxy only; no internet, metadata or production ports')
