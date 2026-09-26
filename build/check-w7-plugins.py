# -*- coding: utf-8 -*-
"""验证 w7 fork 上 dsh 0.1.7 的插件挂载：拉 /plugins/?? 清单并数 __ModuleLoader__.load。"""
import re
import urllib.request

BASE = "http://127.0.0.1:41995"
home = open(r"D:\code\dsh-desktop\build\w7-home.html", "r", encoding="utf-8", errors="replace").read()

# cookie 从 curl 的 cookie jar 里取
cookie = ""
for line in open(r"D:\code\dsh-desktop\build\cj-w7.txt", "r", encoding="utf-8", errors="replace"):
    if line.startswith("#HttpOnly_") or (line and not line.startswith("#")):
        parts = line.strip().split("\t")
        if len(parts) >= 7:
            cookie = parts[5] + "=" + parts[6]
            break

m = re.search(r'/plugins/\?\?[^"\\]+', home)
print("plugins url found:", bool(m))
if m:
    url = BASE + m.group(0).replace("&amp;", "&")
    req = urllib.request.Request(url, headers={"Cookie": cookie})
    body = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    open(r"D:\code\dsh-desktop\build\w7-plugins.js", "w", encoding="utf-8").write(body)
    loads = body.count("__ModuleLoader__.load")
    ids = re.findall(r'id:\s*"([^"]+)"', body)
    print("__ModuleLoader__.load count:", loads)
    print("ids:", ids[:25])
    for key in ("updater", "dshmarket", "directory-picker-desktop"):
        print(key, "->", key in body)
