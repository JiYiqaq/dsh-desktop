// 把 DSH 官方 favicon.svg（黑色鲸鱼）渲染成多尺寸 PNG 并组装 icon.ico
// 用法: node render-icon.js [输出目录] [DSH_HOME]
// 依赖: sharp（复用 DSH profiles 里的实例，不重复安装）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT_DIR = process.argv[2] || path.join(__dirname, 'assets');
const DSH_HOME = process.argv[3] || process.env.DSH_HOME || path.join(os.homedir(), 'AppData', 'Local', 'DeepSeek-Harness');
const SVG_SRC = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg');
const SHARP_PKG = path.join(DSH_HOME, 'profiles', 'node_modules', 'sharp');

let sharp;
try {
  sharp = require(SHARP_PKG);
} catch (e) {
  console.error('未找到 sharp（DSH 未安装或 DSH_HOME 不对）：' + SHARP_PKG);
  console.error('用法: node render-icon.js [输出目录] [DSH_HOME]');
  process.exit(1);
}

// 高密度渲染（50px 视图 → 约 500px）后按需缩小，保证小尺寸清晰
const DENSITY = 720;
const SIZES = [256, 128, 64, 48, 32, 24, 16];

async function main() {
  if (!fs.existsSync(SVG_SRC)) {
    console.error('未找到 DSH favicon.svg：' + SVG_SRC);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const svg = fs.readFileSync(SVG_SRC);
  const pngs = [];
  for (const s of SIZES) {
    const buf = await sharp(svg, { density: DENSITY }).resize(s, s).png().toBuffer();
    pngs.push(buf);
    fs.writeFileSync(path.join(OUT_DIR, `logo-${s}.png`), buf);
    console.log(`rendered ${s}x${s} (${buf.length} bytes)`);
  }
  // 组装 PNG-compressed ICO：ICONDIR(6) + ICONDIRENTRY(16*N) + PNG blobs
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);               // reserved
  header.writeUInt16LE(1, 2);               // type = icon
  header.writeUInt16LE(pngs.length, 4);     // count
  let offset = header.length;
  pngs.forEach((png, i) => {
    const s = SIZES[i];
    const e = 6 + i * 16;
    header.writeUInt8(s === 256 ? 0 : s, e);        // width (0 = 256)
    header.writeUInt8(s === 256 ? 0 : s, e + 1);    // height
    header.writeUInt8(0, e + 2);                    // palette
    header.writeUInt8(0, e + 3);                    // reserved
    header.writeUInt16LE(1, e + 4);                 // planes
    header.writeUInt16LE(32, e + 6);                // bpp
    header.writeUInt32LE(png.length, e + 8);        // bytes in res
    header.writeUInt32LE(offset, e + 12);           // offset
    offset += png.length;
  });
  const ico = Buffer.concat([header, ...pngs]);
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`written ${icoPath} (${ico.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
