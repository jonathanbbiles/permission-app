#!/usr/bin/env python3
"""Build a self-contained @font-face block: every face as a data: URI, no network.

Two things make this much smaller than a naive embed:

1. DEDUPE. Caveat and Oswald are VARIABLE fonts. Google's css2 API answers a
   request for four discrete weights with four @font-face rules that all point at
   the SAME woff2. Embedding it four times would have quadrupled it for nothing,
   so each distinct file is embedded once and declared with a font-weight RANGE,
   which is what a variable font is for.

2. SUBSET CHOICE. Google serves latin, latin-ext, cyrillic, cyrillic-ext,
   vietnamese and devanagari. Only latin/latin-ext can be reached here.
     - Poppins is --body: EVERY word the user writes renders in it, so it keeps
       latin AND latin-ext (accented European characters must not fall back).
     - Oswald is --display: headings and the reflection prompts. latin + latin-ext.
     - Caveat is --script and renders exactly one app-authored English phrase
       ("today's invitation"), so latin alone. Its latin-ext is 29KB for glyphs
       nothing in this app can ever produce.
"""
import re, sys, base64, urllib.request, os
from collections import OrderedDict

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SUBSETS = {"Poppins": {"latin", "latin-ext"},
           "Oswald":  {"latin", "latin-ext"},
           "Caveat":  {"latin"}}

css = open(sys.argv[1], encoding="utf-8").read()
chunks = re.split(r"(/\* [a-z-]+ \*/)", css)
files = OrderedDict()          # url -> dict
for i in range(1, len(chunks), 2):
    subset = chunks[i].strip("/* ").strip()
    m = re.search(r"@font-face\s*\{(.*?)\}", chunks[i+1], re.S)
    if not m: continue
    b = m.group(1)
    fam    = re.search(r"font-family:\s*'([^']+)'", b).group(1)
    style  = re.search(r"font-style:\s*([^;]+);", b).group(1).strip()
    weight = re.search(r"font-weight:\s*([^;]+);", b).group(1).strip()
    urange = re.search(r"unicode-range:\s*([^;]+);", b).group(1).strip()
    url    = re.search(r"url\((https://[^)]+\.woff2)\)", b).group(1)
    if subset not in SUBSETS.get(fam, set()):
        continue
    e = files.setdefault(url, {"fam": fam, "subset": subset, "style": style,
                               "urange": urange, "weights": []})
    e["weights"].append(int(weight))

out, raw_total = [], 0
print("%-8s %-9s %-8s %-9s %8s" % ("family", "subset", "weights", "style", "size"))
for url, e in files.items():
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA})).read()
    raw_total += len(data)
    ws = sorted(set(e["weights"]))
    # one variable file covering several weights -> declare the RANGE, not copies
    wcss = str(ws[0]) if len(ws) == 1 else "%d %d" % (ws[0], ws[-1])
    print("%-8s %-9s %-8s %-9s %7.1fK" % (e["fam"], e["subset"], wcss, e["style"], len(data)/1024))
    out.append("@font-face{font-family:'%s';font-style:%s;font-weight:%s;font-display:swap;"
               "src:url(data:font/woff2;base64,%s) format('woff2');unicode-range:%s;}"
               % (e["fam"], e["style"], wcss,
                  base64.b64encode(data).decode("ascii"), e["urange"]))

open(sys.argv[2], "w", encoding="utf-8").write("\n".join(out) + "\n")
print("\n%d files | raw %.1f KB -> embedded CSS %.1f KB"
      % (len(files), raw_total/1024, os.path.getsize(sys.argv[2])/1024))
