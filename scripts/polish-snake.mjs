import fs from "node:fs";

const FADE_MS = 2200; // Duration for smooth fade-in wave after snake returns home
const STAGGER_MS = 600; // Gentle left-to-right wave spread across columns
const HOLD_MS = 3800; // Calm showcase hold showing full real commit graph

function fmtPct(val) {
  return `${Number(val.toFixed(3))}%`;
}

function parseRootColors(css) {
  const colors = {};
  const rootMatch = css.match(/:root\{([^}]+)\}/);
  if (!rootMatch) return colors;
  for (const part of rootMatch[1].split(";")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (k && v) colors[k] = v;
  }
  return colors;
}

function resolveColor(token, colors) {
  const m = token.match(/^var\((--[a-zA-Z0-9_-]+)\)$/);
  if (m && colors[m[1]]) return colors[m[1]];
  return token;
}

function parseCellPositions(svgBody) {
  // Map cell class name (e.g. "c0") -> normalized horizontal position [0..1]
  const xs = new Map();
  let minX = Infinity;
  let maxX = -Infinity;
  const re = /<rect[^>]*class="c (c[0-9a-zA-Z_-]+)"[^>]*\sx="([0-9.]+)"[^>]*\/?>/g;
  let match;
  while ((match = re.exec(svgBody)) !== null) {
    const cls = match[1];
    const x = parseFloat(match[2]);
    xs.set(cls, x);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const span = Math.max(1, maxX - minX);
  const norm = new Map();
  for (const [cls, x] of xs.entries()) {
    norm.set(cls, (x - minX) / span);
  }
  return norm;
}

function parseKeyframeStops(body) {
  const stops = [];
  const re = /([0-9.,%\s]+)\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const pcts = match[1]
      .split(",")
      .map((s) => parseFloat(s.trim().replace("%", "")))
      .filter((n) => !Number.isNaN(n));
    stops.push({ pcts, decl: match[2].trim() });
  }
  return stops;
}

function polishSvg(filePath) {
  const svg = fs.readFileSync(filePath, "utf8");
  const styleStart = svg.indexOf("<style>");
  const styleEnd = svg.indexOf("</style>");
  if (styleStart === -1 || styleEnd === -1) {
    throw new Error(`No <style> block found in ${filePath}`);
  }

  let css = svg.slice(styleStart + 7, styleEnd);
  const svgBody = svg.slice(styleEnd + 8);

  // Extract original animation duration (e.g. 29500ms)
  const durMatch = css.match(/\b(\d+)ms\b/);
  if (!durMatch) {
    throw new Error(`Could not detect animation duration in ${filePath}`);
  }
  const origMs = parseInt(durMatch[1], 10);
  const totalMs = origMs + FADE_MS + HOLD_MS;
  const scale = origMs / totalMs;
  const fadeStartPct = (origMs / totalMs) * 100;
  const fadeBaseDurPct = ((FADE_MS - STAGGER_MS) / totalMs) * 100;
  const staggerSpanPct = (STAGGER_MS / totalMs) * 100;

  const colors = parseRootColors(css);
  const emptyHex = colors["--ce"] || "#161b22";
  const cellNormX = parseCellPositions(svgBody);

  // 1. Update duration everywhere in style block
  css = css.replace(new RegExp(`\\b${origMs}ms\\b`, "g"), `${totalMs}ms`);

  // 2. Transform all @keyframes blocks
  css = css.replace(
    /@keyframes\s+([a-zA-Z0-9_-]+)\{((?:[^{}]|\{[^}]*\})*)\}/g,
    (fullMatch, name, body) => {
      const stops = parseKeyframeStops(body);
      if (stops.length === 0) return fullMatch;

      // Case A: Commit cells (c0, c1, ..., c28)
      if (/^c[0-9a-zA-Z_-]+$/.test(name)) {
        const fillMatch = body.match(/fill\s*:\s*([^;}\s]+)/);
        const origColorToken = fillMatch ? fillMatch[1] : "var(--c1)";
        const commitHex = resolveColor(origColorToken, colors);

        // First stop = last moment before eaten; second stop = moment eaten
        const beforeEatPct = stops[0]?.pcts?.[0];
        const afterEatPct = stops[1]?.pcts?.[0];
        if (beforeEatPct === undefined || afterEatPct === undefined) {
          return fullMatch;
        }

        const pBefore = beforeEatPct * scale;
        const pAfter = afterEatPct * scale;
        const nx = cellNormX.get(name) ?? 0;
        const pFadeStart = fadeStartPct + nx * staggerSpanPct;
        const pFadeEnd = pFadeStart + fadeBaseDurPct;

        return `@keyframes ${name}{0%,${fmtPct(pBefore)}{fill:${commitHex}}${fmtPct(pAfter)},${fmtPct(pFadeStart)}{fill:${emptyHex}}${fmtPct(pFadeEnd)},100%{fill:${commitHex}}}`;
      }

      // Case B: Snake body segments (s0, s1, s2, s3)
      if (/^s\d+$/.test(name)) {
        let homeTransform = null;
        const rebuilt = stops.map(({ pcts, decl }) => {
          const hasZero = pcts.includes(0);
          if (hasZero && !homeTransform) {
            homeTransform = decl;
          }
          const scaledPcts = pcts.map((p) => fmtPct(p * scale));
          if (hasZero) {
            scaledPcts.push("100%");
          }
          return `${scaledPcts.join(",")}{${decl}}`;
        });
        if (!homeTransform) {
          rebuilt.push(`100%{${stops[0].decl}}`);
        }
        return `@keyframes ${name}{${rebuilt.join("")}}`;
      }

      // Case C: Progress bars (u0, u1, u2, u3) -> fade out smoothly while grid fades in
      if (/^u\d+$/.test(name)) {
        const fadeOutEndPct = ((origMs + FADE_MS * 0.75) / totalMs) * 100;
        const lastStop = stops[stops.length - 1];
        const finalScaleDecl = lastStop?.decl || "transform:scale(1.000,1)";
        const lastHas100 = lastStop?.pcts?.includes(100);
        const rebuilt = stops.map(({ pcts, decl }) => {
          const scaledPcts = pcts.map((p) => fmtPct(p * scale));
          return `${scaledPcts.join(",")}{${decl};opacity:1}`;
        });
        rebuilt.unshift(`0%{transform:scale(0.000,1);opacity:1}`);
        if (!lastHas100) {
          rebuilt.push(`${fmtPct(fadeStartPct)}{${finalScaleDecl};opacity:1}`);
        }
        rebuilt.push(`${fmtPct(fadeOutEndPct)}{${finalScaleDecl};opacity:0}`);
        rebuilt.push(`99.98%{transform:scale(0.000,1);opacity:0}`);
        rebuilt.push(`100%{transform:scale(0.000,1);opacity:1}`);
        return `@keyframes ${name}{${rebuilt.join("")}}`;
      }

      return fullMatch;
    }
  );

  // 3. Respect prefers-reduced-motion cleanly
  css += `@media(prefers-reduced-motion:reduce){.c,.s,.u{animation:none!important}.s,.u{opacity:0}}`;

  const output = svg.slice(0, styleStart + 7) + css + svg.slice(styleEnd);
  fs.writeFileSync(filePath, output, "utf8");
  console.log(
    `Polished ${filePath}: ${origMs}ms -> ${totalMs}ms (${cellNormX.size} cells, smooth wave fade-in + hold)`
  );
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/polish-snake.mjs <svg-file> [...]");
  process.exit(1);
}

for (const file of files) {
  polishSvg(file);
}
