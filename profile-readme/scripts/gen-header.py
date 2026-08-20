THEMES = {
    "light": dict(bg="#F4F3EF", ink="#0E0E0E", muted="#6E6C66", screen="#FFFFFF",
                  case="#E7E5DF", line="#D6D3CB", dot="#0E0E0E"),
    "dark":  dict(bg="#0B0B0B", ink="#F2F1EC", muted="#8B8A85", screen="#151513",
                  case="#1C1C1A", line="#2E2E2B", dot="#F2F1EC"),
}

MENU = ["roll", "market", "notebook", "transit", "library", "sudoku"]

TPL = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 300" width="1000" height="300" role="img" aria-label="gi-os — Giovanni Lupo, apps for phones that do less">
  <defs>
    <pattern id="dither" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="none"/>
      <circle cx="1" cy="1" r="0.6" fill="{dot}" opacity="0.22"/>
      <circle cx="3" cy="3" r="0.6" fill="{dot}" opacity="0.22"/>
    </pattern>
    <style>
      .m {{ font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }}
    </style>
  </defs>

  <rect width="1000" height="300" fill="{bg}"/>
  <rect x="0" y="0" width="1000" height="300" fill="url(#dither)"/>

  <!-- device -->
  <rect x="64" y="26" width="168" height="248" rx="20" fill="{case}" stroke="{line}" stroke-width="2"/>
  <rect x="80" y="42" width="136" height="196" rx="6" fill="{screen}" stroke="{line}" stroke-width="1"/>
  <circle cx="148" cy="256" r="7" fill="none" stroke="{line}" stroke-width="2"/>

  <!-- status bar -->
  <text class="m" x="92" y="61" font-size="10" fill="{muted}">9:41</text>
  <rect x="182" y="53" width="20" height="9" rx="2" fill="none" stroke="{muted}" stroke-width="1"/>
  <rect x="184" y="55" width="11" height="5" fill="{muted}"/>
  <rect x="203" y="55.5" width="2" height="4" rx="1" fill="{muted}"/>
  <line x1="88" y1="70" x2="208" y2="70" stroke="{line}" stroke-width="1"/>
{menu}
  <!-- wordmark -->
  <text class="m" x="286" y="130" font-size="86" font-weight="700" letter-spacing="-3" fill="{ink}">gi-os</text>
  <text class="m" x="290" y="164" font-size="17" letter-spacing="4" fill="{muted}">GIOVANNI LUPO</text>
  <line x1="290" y1="188" x2="936" y2="188" stroke="{line}" stroke-width="2"/>
  <text class="m" x="290" y="218" font-size="20" fill="{ink}">apps for phones that do less</text>
  <text class="m" x="290" y="248" font-size="13" fill="{muted}">kotlin  ·  black + white  ·  new york  ·  gzl.dev</text>
</svg>
"""

ROW = ('  <text class="m" x="92" y="{y}" font-size="11" fill="{fill}">{caret} {name}</text>\n')

for theme, c in THEMES.items():
    rows = ""
    for i, name in enumerate(MENU):
        y = 92 + i * 22
        fill = c["ink"] if i == 0 else c["muted"]
        rows += ROW.format(y=y, fill=fill, caret="›" if i == 0 else " ", name=name)
    rows += ('  <rect x="88" y="{y}" width="120" height="18" fill="none" stroke="{line}" '
             'stroke-width="1" stroke-dasharray="2 3"/>\n').format(y=92 + len(MENU) * 22 - 12, line=c["line"])
    rows += ('  <text class="m" x="98" y="{y}" font-size="9" fill="{muted}">'
             '+ brightmarket</text>\n').format(y=92 + len(MENU) * 22, muted=c["muted"])
    open("assets/header-%s.svg" % theme, "w").write(TPL.format(menu=rows, **c))
    print("wrote", theme)
