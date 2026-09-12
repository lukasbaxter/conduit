#!/usr/bin/env python3
"""Keep Explo's ListenBrainz credentials in step with what the user saved in
Conduit's Settings (Jellyfin DisplayPreferences, client 'conduit'). Runs as
root from cron every 5 minutes on .85; restarts Explo when they change.

    python3 sync_token.py lukasbaxter
"""
import json, os, re, subprocess, sys, urllib.request

JF = 'http://192.168.1.85:2101'
KEY = open('/home/lukas/.jellyfin.key').read().strip()
ENV = '/home/admin/services/explo/.env'
user_name = sys.argv[1] if len(sys.argv) > 1 else 'lukasbaxter'

def req(path):
    r = urllib.request.Request(JF + path, headers={'X-Emby-Token': KEY})
    with urllib.request.urlopen(r, timeout=30) as resp: return json.load(resp)

uid = next(u['Id'] for u in req('/Users') if u['Name'] == user_name)
dp = req(f'/DisplayPreferences/conduit?userId={uid}&client=conduit')
raw = (dp.get('CustomPrefs') or {}).get('listenbrainz')
lb = json.loads(raw) if raw else {}
user, token = (lb.get('user') or '').strip(), (lb.get('token') or '').strip()

env = open(ENV).read()
def setk(text, k, v):
    return re.sub(rf'^{k}=.*$', f'{k}={v}', text, flags=re.M) if re.search(rf'^{k}=', text, re.M) else text + f'\n{k}={v}\n'
new = setk(setk(env, 'LISTENBRAINZ_USER', user), 'LISTENBRAINZ_USER_TOKEN', token)
if new != env:
    open(ENV, 'w').write(new)
    subprocess.run(['docker', 'restart', 'explo'], check=False)
    print(f'explo: listenbrainz credentials updated (user={user or "-"}, token={"set" if token else "empty"}), restarted')
else:
    print('explo: unchanged')
