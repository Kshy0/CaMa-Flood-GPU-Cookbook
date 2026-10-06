Inline a figure (so it uses the page fonts and light/dark colours) with a raw `<figure class="fig">` block — no `markdown` attribute, which would mangle the SVG — and write the caption in HTML:
`<figure class="fig">` / `--8<-- "figures/time-axis.svg"` / `<figcaption>Caption with <code>code</code>.</figcaption>` / `</figure>` (one per line, blank line before and after).
