// One-off: derives the PWA icons from the sources in /assets and writes them to
// apps/shell/public/. The results are committed, so a build and CI need no image
// tooling; run this only when the sources change:
//
//   npm run icons -w substacker-shell
//
// Sources: assets/icon.webp (the full-colour icon, square) and assets/icon.svg
// (the glyph alone, copied as the vector favicon). Needs the `sharp` devDependency.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const shellDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(shellDir, "..", "..", "assets");
const publicDir = join(shellDir, "public");
const source = join(assets, "icon.webp");

const meta = await sharp(source).metadata();
if (meta.width !== meta.height) throw new Error(`icon.webp must be square, got ${meta.width}x${meta.height}`);

// The icon's own background, averaged over small patches in the four corners. The
// maskable variant is painted with it so the extra margin matches the artwork.
async function cornerColour() {
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const patch = 8;
  const sum = [0, 0, 0];
  let n = 0;
  for (const ox of [0, info.width - patch]) {
    for (const oy of [0, info.height - patch]) {
      for (let y = oy; y < oy + patch; y++) {
        for (let x = ox; x < ox + patch; x++) {
          for (let c = 0; c < 3; c++) sum[c] += data[(y * info.width + x) * 3 + c];
          n++;
        }
      }
    }
  }
  const [r, g, b] = sum.map((s) => Math.round(s / n));
  return { r, g, b, hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` };
}

const background = await cornerColour();
mkdirSync(publicDir, { recursive: true });

async function square(size, name) {
  await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toFile(join(publicDir, name));
}

await square(192, "icon-192.png");
await square(512, "icon-512.png");
await square(180, "apple-touch-icon.png");

// Maskable: the whole icon at 80% (inside the 80% safe zone, which platforms may
// crop to a circle) centred on the icon's own background colour.
const inner = Math.round(512 * 0.8);
const margin = Math.round((512 - inner) / 2);
await sharp({ create: { width: 512, height: 512, channels: 3, background: background.hex } })
  .composite([{ input: await sharp(source).resize(inner, inner).png().toBuffer(), left: margin, top: margin }])
  .png({ compressionLevel: 9 })
  .toFile(join(publicDir, "icon-maskable-512.png"));

copyFileSync(join(assets, "icon.svg"), join(publicDir, "icon.svg"));
console.log(`icons written to ${publicDir}; icon background ${background.hex}`);
