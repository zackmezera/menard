#!/usr/bin/env python3
"""pdftotext output -> Markdown paragraphs: drops running heads/page numbers, rejoins lines.
ponytail: line-length heuristic for paragraph ends; misses a paragraph whose last line happens to be full width."""
import re, sys

def clean(text: str) -> str:
    lines = []
    for page in text.split("\f"):
        body = [l.rstrip() for l in page.splitlines()]
        while body and not body[0].strip(): body.pop(0)
        while body and not body[-1].strip(): body.pop()
        # running head / folio: short lines at the top or bottom of a page
        for _ in range(3):
            if body and len(body[0].strip()) < 35: body.pop(0)
            while body and not body[0].strip(): body.pop(0)
        for _ in range(2):
            if body and (len(body[-1].strip()) < 6): body.pop()
        lines += [l for l in body if l.strip()]
    width = sorted(len(l) for l in lines)[len(lines) * 3 // 4] if lines else 60
    paras, cur = [], ""
    for l in lines:
        l = l.strip()
        if cur.endswith("-") and l[:1].islower(): cur = cur[:-1] + l
        else: cur = f"{cur} {l}".strip()
        if len(l) < width * 0.8 and re.search(r"[.?!:\"”)]$", l):
            paras.append(cur); cur = ""
    if cur: paras.append(cur)
    return "\n\n".join(paras) + "\n"

def demo():
    t = "Signs\n\nFirst line of a para that is long enough to count as full width here\nends.\nNext para starts and is also long enough to count as full width\nhere and con-\ntinues.\f2\n"
    out = clean(t)
    assert "ends.\n\nNext" in out and "continues." in out, out

if __name__ == "__main__":
    if sys.argv[1:] == ["--demo"]: demo(); print("ok")
    else: sys.stdout.write(clean(sys.stdin.read()))
