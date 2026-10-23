# Diagrams

Each `.mmd` file is the Mermaid source. The matching `.svg` is rendered from it with [Pele](https://pele.run/) 1.9.0 and is what the documentation embeds.

| Source | Shown in |
|---|---|
| `architecture.mmd` | README: component overview |
| `send-sequence.mmd` | README: `send` / `read-result` sequence |
| `request-states.mmd` | README: request states |
| `routing-execute.mmd` | docs/QUOTA-ROUTING.md: `execute` gates |

## Regenerating

Pele is not a dependency of this repository. To re-render after editing a source, install it in a separate temporary folder and run a script like this from there:

```js
import {readFileSync, writeFileSync} from 'node:fs';
import {render} from 'pele';

const theme = '<style>.pele{--pele-bg:#ffffff;--pele-fg:#1f2328;--pele-muted:#59636e;--pele-line:#59636e;--pele-surface:#f6f8fa;--pele-surface-alt:#eaeef2;--pele-border:#8c959f;--pele-accent:#0969da;background:var(--pele-bg)}@media (prefers-color-scheme: dark){.pele{--pele-bg:#0d1117;--pele-fg:#e6edf3;--pele-muted:#9198a1;--pele-line:#9198a1;--pele-surface:#161b22;--pele-surface-alt:#21262d;--pele-border:#3d444d;--pele-accent:#4493f8}}</style>';
const [source, target] = process.argv.slice(2);
const name = target.replace(/^.*[\\/]/, '').replace(/\.svg$/, '').replace(/[^a-z]/g, '');
const {svg} = render(readFileSync(source, 'utf8'), {responsive: false, autoDirection: false, padding: 16, idPrefix: name,
  fontFamily: '-apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif'});
writeFileSync(target, svg.replace(/^(<svg[^>]*>)/, '$1' + theme) + '\n');
```

The injected `<style>` gives each SVG a light palette and a dark palette (through `prefers-color-scheme`), so the images stay readable in both GitHub themes. The committed SVGs were rendered in a browser, where Pele measures text with canvas. Node uses a built-in width table instead, so node widths may differ slightly.

After regenerating, run `npm run manifest:update`.
