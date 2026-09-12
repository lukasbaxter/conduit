from jf import *
import json
u=user_id()
d=req(f"/Items?userId={u}&IncludeItemTypes=MusicAlbum&Recursive=true&Fields=Path,ImageTags,ChildCount,AlbumArtist&Limit=20000")
al=d["Items"]; print("albums",len(al))
noimg=[a for a in al if not (a.get("ImageTags") or {}).get("Primary")]
print("albums without cover:",len(noimg), "tracks in them:", sum(a.get("ChildCount") or 0 for a in noimg))
json.dump(noimg,open("albums_noimg.json","w"),ensure_ascii=False)
for a in noimg[:40]: print("  ",a.get("AlbumArtist"),"|",a["Name"],"|",a.get("Path"),"|",a.get("ChildCount"))
