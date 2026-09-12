import json, os, urllib.request, urllib.parse
JF = os.environ.get("JF_URL", "http://192.168.1.85:2101")
KEY = os.environ.get("JF_KEY") or open(os.path.expanduser("~/.jellyfin.key")).read().strip()
def req(path, method="GET", body=None, raw=None, ctype="application/json", timeout=120):
    h = {"X-Emby-Token": KEY, "Content-Type": ctype}
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(JF + path, method=method, headers=h, data=data)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        d = resp.read()
        try: return json.loads(d) if d else None
        except ValueError: return d
def user_id(name="lukasbaxter"):
    return next(u["Id"] for u in req("/Users") if u["Name"] == name)
