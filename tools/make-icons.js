// Builds the extension icons from store/icon-source.png (needs ImageMagick 7 `magick` on PATH).
// Run: node tools/make-icons.js
//
// The source is a 1254px render with a glow around a rounded square; we crop
// to the square, round its corners, then export:
//   icons/icon-{16,32,48,128}.png  normal
//   icons/off-{16,32,48}.png       paused (greyscale)
// icon-128 keeps 8px transparent padding, as the Chrome Web Store expects.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'store', 'icon-source.png');
const out = path.join(root, 'icons');
const master = path.join(os.tmpdir(), 'cam-icon-master.png');

// Rounded square within the source image (measured from the render).
const CROP = { x: 87, y: 87, size: 1080, radius: 170 };

const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });

magick(src, '-crop', `${CROP.size}x${CROP.size}+${CROP.x}+${CROP.y}`, '+repage',
  '(', '-size', `${CROP.size}x${CROP.size}`, 'xc:none', '-fill', 'white',
  '-draw', `roundrectangle 0,0 ${CROP.size - 1},${CROP.size - 1} ${CROP.radius},${CROP.radius}`, ')',
  '-compose', 'DstIn', '-composite', master);

fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (f.endsWith('.png')) fs.unlinkSync(path.join(out, f));

function resize(size, dest, extra = []) {
  // Small sizes get a touch of sharpening so the speaker and X stay crisp.
  const sharpen = size <= 48 ? ['-unsharp', '0x0.6+0.8+0'] : [];
  magick(master, '-filter', 'Lanczos', '-resize', `${size}x${size}`, ...sharpen, ...extra, dest);
}

for (const size of [16, 32, 48]) {
  resize(size, path.join(out, `icon-${size}.png`));
  resize(size, path.join(out, `off-${size}.png`), ['-modulate', '80,0']);
}
// 128: 112px artwork centred on a transparent 128px canvas.
magick(master, '-filter', 'Lanczos', '-resize', '112x112', '-background', 'none',
  '-gravity', 'center', '-extent', '128x128', path.join(out, 'icon-128.png'));

console.log('icons written to', out);
