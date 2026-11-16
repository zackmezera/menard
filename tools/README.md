# Tools

Shell helpers that work outside Obsidian. Python standard library only.

## pdf_paragraphs.py

Turns `pdftotext` output into Markdown paragraphs: drops running heads and page numbers at the top and bottom of each page, rejoins lines, and dehyphenates words broken at a line end.

```sh
pdftotext -f 16 -l 19 book.pdf - | python3 tools/pdf_paragraphs.py > intro.md
python3 tools/pdf_paragraphs.py --demo   # self-check
```

`pdftotext` comes with Poppler (`brew install poppler`). The plugin's **Import PDF text as a note** command does the same job inside Obsidian from pdf.js text positions, and also writes `%%p. N%%` page markers; use this script when you want the text from a terminal.

Paragraph ends are guessed from line length, so a paragraph whose last line happens to be full width runs into the next one.
