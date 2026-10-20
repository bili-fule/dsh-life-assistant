#!/usr/bin/env python3
"""Root-only network setup. Rules affect only the dedicated browser bridge."""
import ipaddress,json,pathlib,subprocess,sys,time
NETWORK='yoyo-browser';BRIDGE='br-yoyo-browser';SUBNET='172.29.61.0/28'
DENIED=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4']
def run(args,check=True):return subprocess.run(args,text=True,capture_output=True,check=check)
def configure(policy):
 r=run(['docker','network','inspect',NETWORK],False)
 if r.returncode:
  run(['docker','network','create','--driver','bridge','--subnet',SUBNET,'--opt','com.docker.network.bridge.name='+BRIDGE,NETWORK])
 n=json.loads(run(['docker','network','inspect',NETWORK]).stdout)[0]
 if n.get('EnableIPv6') or n.get('Options',{}).get('com.docker.network.bridge.name')!=BRIDGE or [x.get('Subnet') for x in n['IPAM']['Config']]!=[SUBNET]:raise RuntimeError('Existing browser network does not match the fixed policy')
 # Construct a complete new chain before linking, so reload never has an empty
 # allow-all interval. Existing protection is retained if any command fails.
 chain='YOYO_BR_'+str(time.time_ns())[-12:]
 ipt=lambda *a:run(['iptables','--wait','5',*a])
 ipt('-N',chain)
 for network in DENIED+[str(ipaddress.IPv4Address(x))+'/32' for x in policy.get('denyHosts',[])]:ipt('-A',chain,'-d',network,'-j','DROP')
 for port in ['80','443','53']:ipt('-A',chain,'-p','tcp','--dport',port,'-j','RETURN')
 ipt('-A',chain,'-p','udp','--dport','53','-j','RETURN');ipt('-A',chain,'-j','DROP')
 ipt('-I','DOCKER-USER','1','-i',BRIDGE,'-j',chain)
 # Traffic addressed to this host enters INPUT rather than DOCKER-USER.
 if run(['iptables','--wait','5','-C','INPUT','-i',BRIDGE,'-j','DROP'],False).returncode:ipt('-I','INPUT','1','-i',BRIDGE,'-j','DROP')
 print('Dedicated browser network and egress policy ready')
if __name__=='__main__':configure(json.loads(pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '/etc/yoyo-browser/policy.json').read_text()))
