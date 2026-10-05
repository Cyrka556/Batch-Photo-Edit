import { useState, useRef, useEffect, Component } from "react";

/* ============================================================
   LATENT — a non-destructive photo developer
   Memory model (built for large batches, 100+ raw files):
   - At import we store ONLY: the File handle, the byte span of
     the embedded JPEG preview (for raws), and a ~160px thumbnail.
     No decoded pixels are retained per photo.
   - The working preview for the ACTIVE frame is decoded on
     demand and held in a small LRU cache (6 entries).
   - Full resolution is decoded transiently at export time and
     discarded immediately after encoding.
   - All edits remain parametric and non-destructive: sources
     are never modified.
   ============================================================ */

const DEFAULTS = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  whites: 0, blacks: 0, temperature: 0, tint: 0,
  vibrance: 0, saturation: 0, sharpen: 0,
  mono: false, tone: null,
};

const PRESETS = [
  { name: "None", p: { mono: false, tone: null } },
  { name: "B&W Classic", p: { mono: true, tone: null, contrast: 12 } },
  { name: "B&W Punch", p: { mono: true, tone: null, contrast: 32, blacks: -14, whites: 10 } },
  { name: "Sepia", p: { mono: true, tone: [1.14, 1.0, 0.8], contrast: 6 } },
  { name: "Film Fade", p: { mono: false, tone: null, blacks: 20, contrast: -8, saturation: -14 } },
  { name: "Golden Hour", p: { mono: false, tone: null, temperature: 26, vibrance: 12, shadows: 8 } },
  { name: "Cool Matte", p: { mono: false, tone: null, temperature: -18, blacks: 14, saturation: -8 } },
  { name: "Vivid", p: { mono: false, tone: null, vibrance: 26, contrast: 10 } },
];

/* ---------- Standalone (self-hosted) mode ----------
   When built as a PWA (esbuild --define:__STANDALONE__=true) the app calls
   Anthropic directly from the browser using a key the user pastes into
   Settings. The key lives ONLY in this browser's localStorage — it is never
   in the source, the repo, or the hosted files. Inside a Claude artifact
   (STANDALONE false) none of this applies; the platform handles the call. */
const STANDALONE = typeof __STANDALONE__ !== "undefined";
const KEY_STORE = "latent.apiKey";
const MODEL_STORE = "latent.model";
const DEFAULT_MODEL = "claude-sonnet-5-5";
const readStore = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const writeStore = (k, v) => {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); return true; }
  catch { return false; }
};

const RAW_EXT = ["cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2"];
const IMG_EXT = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "avif"];

const BATCH_PROMPT =
`You are a professional photographer culling and developing a shoot. For this frame do three things and answer in one JSON object.

1. TRIAGE — "keep" or "reject". Reject ONLY frames that are obviously unusable: severely out of focus or motion-blurred across the whole frame, essentially black or completely blown out with nothing recoverable, or clearly accidental shots (ground, pocket, lens cap, ceiling). Be deliberately lenient: a mediocre, flawed, or awkward photo is a KEEP — it can be worked on later. Never reject for composition, subject matter, or taste. When in any doubt at all, keep.

2. DEVELOP (if keep) — subtle, ORGANIC corrections only, as a careful photographer would in Lightroom: optimise lighting, white balance, tonal range and clarity for the subject and scene. Do not stylise. Prefer small values; use larger ones only when the frame clearly needs them.

3. CROP (if keep) — one conservative composition crop: deliberate subject placement, trim dead space and edge distractions, respect the horizon. A good crop usually keeps most of the frame; if it is already well composed, return a near-full crop.

Respond with ONLY a JSON object, no markdown fences:
{"verdict": "keep" | "reject",
 "reason": "brief, only meaningful when rejecting",
 "develop": {"exposure": float -3..3, "contrast": int -100..100, "highlights": int -100..100, "shadows": int -100..100, "whites": int -100..100, "blacks": int -100..100, "temperature": int -100..100, "tint": int -100..100, "vibrance": int -100..100, "saturation": int -100..100, "sharpen": int 0..100},
 "crop": {"x": float 0-1, "y": float 0-1, "w": float 0-1, "h": float 0-1},
 "rationale": "one sentence, in a photographer's voice"}
crop x,y is the top-left corner; ensure x+w<=1 and y+h<=1.`;

/* ---------- RAW handling: locate the embedded JPEG (byte span only) ---------- */

// TIFF-based raws (CR2/NEF/ARW/DNG): IFD0 usually sits in the first few KB,
// so we can find the preview span from a small header read — no full-file read.
function tiffSpan(headBuf, fileSize) {
  try {
    const dv = new DataView(headBuf);
    const b0 = dv.getUint16(0, false);
    let little;
    if (b0 === 0x4949) little = true;
    else if (b0 === 0x4d4d) little = false;
    else return null;
    const ifdOff = dv.getUint32(4, little);
    if (ifdOff <= 0 || ifdOff + 2 >= headBuf.byteLength) return null;
    const n = dv.getUint16(ifdOff, little);
    let off = null, len = null;
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > headBuf.byteLength) break;
      const tag = dv.getUint16(e, little);
      const val = dv.getUint32(e + 8, little);
      if (tag === 0x0111) off = val;
      if (tag === 0x0117) len = val;
    }
    if (off != null && len != null && len > 4096 && off + len <= fileSize) return { off, len };
    return null;
  } catch { return null; }
}

// Fallback (CR3 etc.): scan a buffer for the largest JPEG span.
function scanJpegSpan(buf) {
  const u8 = new Uint8Array(buf);
  const sois = [];
  for (let i = 0; i < u8.length - 2 && sois.length < 12; i++) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) sois.push(i);
  }
  let best = null;
  for (const s of sois) {
    for (let j = s + 2; j < u8.length - 1; j++) {
      if (u8[j] === 0xff && u8[j + 1] === 0xd9) {
        const len = j + 2 - s;
        if (!best || len > best.len) best = { off: s, len };
        break;
      }
    }
  }
  return best && best.len > 20000 ? best : null;
}

/* ---------- Minimal ZIP writer (store method — JPEGs don't recompress) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files /* [{name, u8}] */) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const crc = crc32(f.u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);        // version needed
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.u8.length, true);
    lh.setUint32(22, f.u8.length, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(lh.buffer, nameB, f.u8);
    central.push({ nameB, crc, size: f.u8.length, offset });
    offset += 30 + nameB.length + f.u8.length;
  }
  const cdParts = [];
  let cdSize = 0;
  for (const c of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, c.crc, true);
    cd.setUint32(20, c.size, true);
    cd.setUint32(24, c.size, true);
    cd.setUint16(28, c.nameB.length, true);
    cd.setUint32(42, c.offset, true);
    cdParts.push(cd.buffer, c.nameB);
    cdSize += 46 + c.nameB.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...cdParts, eocd.buffer], { type: "application/zip" });
}

/* ---------- Metadata carry-over ----------
   Canvas encoding produces a fresh JPEG with no EXIF. These helpers copy the
   EXIF and XMP APP1 segments from the source JPEG (the raw's embedded preview
   carries the camera's full EXIF) into the exported file. The Orientation tag
   is rewritten to 1 because our pixels are already upright — copying it
   verbatim would make viewers double-rotate. */

function normalizeOrientation(seg) {
  try {
    const t = 10; // ff e1 <len:2> 'Exif\0\0' → TIFF header
    const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
    const b0 = dv.getUint16(t, false);
    const little = b0 === 0x4949 ? true : b0 === 0x4d4d ? false : null;
    if (little === null) return seg;
    const ifd = t + dv.getUint32(t + 4, little);
    const n = dv.getUint16(ifd, little);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (dv.getUint16(e, little) === 0x0112) { dv.setUint16(e + 8, 1, little); break; }
    }
  } catch { /* leave segment untouched */ }
  return seg;
}

function extractJpegMeta(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return []; // not a JPEG (e.g. PNG input)
  const segs = [];
  let i = 2;
  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xff) break;
    const marker = u8[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts — done
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2 || i + 2 + len > u8.length) break;
    if (marker === 0xe1 && len > 8) {
      const seg = u8.slice(i, i + 2 + len);
      const head = String.fromCharCode(...seg.slice(4, 10));
      if (head.startsWith("Exif")) segs.push(normalizeOrientation(seg));
      else if (String.fromCharCode(...seg.slice(4, 32)).includes("ns.adobe.com/xap")) segs.push(seg);
    }
    i += 2 + len;
  }
  return segs;
}

async function withMetadata(outBlob, srcBlob, format) {
  if (format !== "image/jpeg") return outBlob; // EXIF splice is a JPEG concept
  try {
    const segs = extractJpegMeta(await srcBlob.arrayBuffer());
    if (!segs.length) return outBlob;
    const out = new Uint8Array(await outBlob.arrayBuffer());
    if (out[0] !== 0xff || out[1] !== 0xd8) return outBlob;
    // EXIF APP1 belongs immediately after SOI
    return new Blob([out.slice(0, 2), ...segs, out.slice(2)], { type: "image/jpeg" });
  } catch {
    return outBlob; // metadata is best-effort — never fail an export over it
  }
}

/* ---------- The develop engine ---------- */

function buildLuts(p) {
  const rG = 1 + p.temperature * 0.0026;
  const bG = 1 - p.temperature * 0.0026;
  const gG = 1 - p.tint * 0.002;
  const ev = Math.pow(2, p.exposure);
  const c = (p.contrast / 100) * 0.9;
  const gains = [rG, gG, bG];
  const luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < 256; i++) {
      let v = i / 255;
      v = Math.pow(Math.pow(v, 2.2) * gains[ch] * ev, 1 / 2.2);
      v = (v - 0.5) * (1 + c) + 0.5;
      v *= 1 + p.whites / 400;
      v = v + (p.blacks / 400) * (1 - Math.min(1, Math.max(0, v)));
      luts[ch][i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return luts;
}

function processPixels(s, d, lr, lg, lb, p, start, end) {
  const hl = p.highlights / 100, sh = p.shadows / 100;
  const sat = p.saturation / 100, vib = p.vibrance / 100;
  const mono = p.mono, tone = p.tone;
  for (let i = start; i < end; i += 4) {
    let r = lr[s[i]], g = lg[s[i + 1]], b = lb[s[i + 2]];
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (hl) { const m = L * L, dd = hl * m * 72; r += dd; g += dd; b += dd; }
    if (sh) { const m = (1 - L) * (1 - L), dd = sh * m * 72; r += dd; g += dd; b += dd; }
    if (mono) {
      const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = g = b = gray;
      if (tone) { r *= tone[0]; g *= tone[1]; b *= tone[2]; }
    } else if (sat || vib) {
      const avg = (r + g + b) / 3;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const pixSat = (mx - mn) / 255;
      const f = (1 + sat) * (1 + vib * (1 - pixSat) * 0.9);
      r = avg + (r - avg) * f; g = avg + (g - avg) * f; b = avg + (b - avg) * f;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
  }
}

// Synchronous — used for interactive previews (small, fast)
function develop(src, p) {
  const out = new ImageData(src.width, src.height);
  const [lr, lg, lb] = buildLuts(p);
  processPixels(src.data, out.data, lr, lg, lb, p, 0, src.data.length);
  if (p.sharpen > 0) unsharp(out, p.sharpen / 100 * 0.9, 0, out.height);
  return out;
}

// Chunked with yields — used for full-resolution exports so multi-second
// pixel work never freezes the page (critical during long batch runs)
async function developAsync(src, p) {
  const out = new ImageData(src.width, src.height);
  const [lr, lg, lb] = buildLuts(p);
  const CHUNK = 4 * 1500000; // ~1.5M pixels per slice
  for (let i = 0; i < src.data.length; i += CHUNK) {
    processPixels(src.data, out.data, lr, lg, lb, p, i, Math.min(src.data.length, i + CHUNK));
    await new Promise((r) => setTimeout(r, 0));
  }
  if (p.sharpen > 0) {
    const k = p.sharpen / 100 * 0.9;
    const copy = new Uint8ClampedArray(out.data);
    const BAND = 500; // rows per slice
    for (let y0 = 0; y0 < out.height; y0 += BAND) {
      unsharpBand(out, copy, k, y0, Math.min(out.height, y0 + BAND));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}

function unsharp(img, k) {
  const copy = new Uint8ClampedArray(img.data);
  unsharpBand(img, copy, k, 0, img.height);
}

function unsharpBand(img, copy, k, y0, y1) {
  const { width: w, height: h, data: d } = img;
  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const j = i + c;
        const blur = (copy[j - 4] + copy[j + 4] + copy[j - w * 4] + copy[j + w * 4] + copy[j] * 4) / 8;
        d[j] = copy[j] + k * (copy[j] - blur);
      }
    }
  }
}

/* ---------- Small helpers ---------- */

function scaleInto(source, maxEdge) {
  const sc = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(source.width * sc));
  c.height = Math.max(1, Math.round(source.height * sc));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c;
}

function rotateCanvas(source, quarter) {
  if (!quarter) return source;
  const c = document.createElement("canvas");
  const swap = quarter % 2 === 1;
  c.width = swap ? source.height : source.width;
  c.height = swap ? source.width : source.height;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return c;
}

function imgDecode(blob) {
  // Fallback decode via <img> for browsers without (working) createImageBitmap
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext("2d").drawImage(im, 0, 0);
      URL.revokeObjectURL(url);
      res(c); // a canvas quacks like a bitmap for our purposes (width/height/drawImage)
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("image decode failed")); };
    im.src = url;
  });
}

async function decodeBitmap(blob, resizeWidth) {
  if (typeof createImageBitmap === "function") {
    // resize during decode when supported (keeps peak memory low for thumbs)
    if (resizeWidth) {
      try { return await createImageBitmap(blob, { resizeWidth, resizeQuality: "medium" }); }
      catch { /* options unsupported — try plain */ }
    }
    try { return await createImageBitmap(blob); }
    catch { /* some mobile webviews expose the API but fail — fall through */ }
  }
  const c = await imgDecode(blob);
  return resizeWidth ? scaleInto(c, resizeWidth) : c;
}

const SLIDERS = {
  light: [
    ["exposure", "Exposure", -3, 3, 0.05],
    ["contrast", "Contrast", -100, 100, 1],
    ["highlights", "Highlights", -100, 100, 1],
    ["shadows", "Shadows", -100, 100, 1],
    ["whites", "Whites", -100, 100, 1],
    ["blacks", "Blacks", -100, 100, 1],
  ],
  colour: [
    ["temperature", "Temperature", -100, 100, 1],
    ["tint", "Tint", -100, 100, 1],
    ["vibrance", "Vibrance", -100, 100, 1],
    ["saturation", "Saturation", -100, 100, 1],
  ],
  detail: [["sharpen", "Sharpen", 0, 100, 1]],
};

export default function App() {
  return (
    <Boundary>
      <Latent />
    </Boundary>
  );
}

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#151412", color: "#e8e3da",
          fontFamily: "system-ui, sans-serif", padding: "28px 20px", fontSize: 14, lineHeight: 1.6 }}>
          <div style={{ color: "#e8a854", fontSize: 20, marginBottom: 8 }}>Latent hit a snag</div>
          <p>Something failed while starting or running the app on this device. The exact error is below —
            share it and it can be fixed:</p>
          <pre style={{ background: "#1c1a17", border: "1px solid #2a2723", borderRadius: 6,
            padding: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, color: "#f0b8a8" }}>
            {String(this.state.error && (this.state.error.stack || this.state.error.message || this.state.error))}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            style={{ background: "#e8a854", border: "none", borderRadius: 5, padding: "8px 16px",
              color: "#1a1408", fontSize: 14, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Latent() {
  // Each image is lightweight: {id, name, isRaw, file, off, len, thumb, rot}
  const [images, setImages] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [adjust, setAdjust] = useState({});
  const [busy, setBusy] = useState("");
  const [aiNote, setAiNote] = useState({});
  const [showOrig, setShowOrig] = useState(false);
  const [fmt, setFmt] = useState("image/jpeg");
  const [quality, setQuality] = useState(90);
  const [expSize, setExpSize] = useState("full");
  const [exportOut, setExportOut] = useState(null); // {url, name, dims, kb}
  const [err, setErr] = useState("");
  const [cropMode, setCropMode] = useState(false);
  const [crops, setCrops] = useState({});
  const [cropAspect, setCropAspect] = useState("0");
  const [cropNote, setCropNote] = useState({});
  const [activePreview, setActivePreview] = useState(null); // {id, rot, img: ImageData}
  const [mode, setMode] = useState("develop");              // "develop" | "batch"
  const [batchItems, setBatchItems] = useState([]);         // [{key,name,status,info}]
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchSummary, setBatchSummary] = useState(null);   // {saved,filtered,failed,toFolder,cancelled}
  const [batchDest, setBatchDest] = useState("");           // human-readable destination
  const [batchQ, setBatchQ] = useState(92);                 // high-quality JPEG default
  const [batchCropOn, setBatchCropOn] = useState(true);
  const [zipOut, setZipOut] = useState(null);               // {url,size,count}
  const [showSettings, setShowSettings] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [modelInput, setModelInput] = useState(DEFAULT_MODEL);
  const [hasKey, setHasKey] = useState(false);
  const [keyMsg, setKeyMsg] = useState("");
  const [stripW, setStripW] = useState(160);                // filmstrip width (px)
  const [panelW, setPanelW] = useState(340);                // adjustment panel width (px)

  const canvasRef = useRef(null);
  const histRef = useRef(null);
  const fileRef = useRef(null);
  const dirRef = useRef(null);
  const raf = useRef(null);
  const viewWrapRef = useRef(null);
  const dragRef = useRef(null);
  const cancelRef = useRef(false);
  const resizeRef = useRef(null);
  const previewCache = useRef(new Map()); // "id:rot" -> ImageData, capped LRU

  // <input webkitdirectory> — React strips the attribute, so set it directly
  useEffect(() => {
    if (dirRef.current) {
      dirRef.current.setAttribute("webkitdirectory", "");
      dirRef.current.setAttribute("directory", "");
    }
  }, [mode]);

  const active = images.find((im) => im.id === activeId) || null;
  const params = activeId ? { ...DEFAULTS, ...(adjust[activeId] || {}) } : DEFAULTS;
  const crop = activeId ? crops[activeId] || null : null;
  const pv = activePreview && activePreview.id === activeId ? activePreview.img : null;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const setParam = (key, val) =>
    setAdjust((a) => ({ ...a, [activeId]: { ...DEFAULTS, ...(a[activeId] || {}), [key]: val } }));

  useEffect(() => {
    setExportOut((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null; });
  }, [activeId]);

  /* ---------- Lazy decode ---------- */

  const previewBlob = (im) => (im.isRaw ? im.file.slice(im.off, im.off + im.len) : im.file);

  const decodePreview = async (im) => {
    const key = im.id + ":" + im.rot;
    const cache = previewCache.current;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key); cache.set(key, v); // refresh LRU order
      return v;
    }
    const bmp = await decodeBitmap(previewBlob(im));
    const scaled = scaleInto(bmp, 1300);   // downscale FIRST, then rotate — cheap
    bmp.close && bmp.close();
    const rotated = rotateCanvas(scaled, im.rot);
    const data = rotated.getContext("2d").getImageData(0, 0, rotated.width, rotated.height);
    cache.set(key, data);
    while (cache.size > 6) cache.delete(cache.keys().next().value);
    return data;
  };

  // Load the working preview whenever the active frame (or its rotation) changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!active) { setActivePreview(null); return; }
      if (activePreview && activePreview.id === active.id && activePreview.rot === active.rot) return;
      try {
        const img = await decodePreview(active);
        if (!cancelled) setActivePreview({ id: active.id, rot: active.rot, img });
      } catch (e) {
        if (!cancelled) setErr(`Couldn't decode ${active.name} — ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, active && active.rot]);

  /* ---------- Import ---------- */

  const importOne = async (file) => {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const isRaw = RAW_EXT.includes(ext);
    let off = 0, len = 0, blob = file;
    if (isRaw) {
      // Cheap path first: TIFF header parse from a 64KB read
      let span = tiffSpan(await file.slice(0, 65536).arrayBuffer(), file.size);
      if (span) {
        const sig = new Uint8Array(await file.slice(span.off, span.off + 2).arrayBuffer());
        if (sig[0] !== 0xff || sig[1] !== 0xd8) span = null;
      }
      if (!span) {
        // Fallback (CR3 etc.): scan the file, then discard the buffer
        span = scanJpegSpan(await file.arrayBuffer());
      }
      if (!span) throw new Error("no embedded preview found");
      off = span.off; len = span.len;
      blob = file.slice(off, off + len);
    }
    // Decode ONLY a thumbnail at import; working pixels come later, on demand
    const bmp = await decodeBitmap(blob, 160);
    const tc = document.createElement("canvas");
    tc.width = bmp.width; tc.height = bmp.height;
    tc.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const thumb = scaleInto(tc, 160).toDataURL("image/jpeg", 0.7);
    const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return { id, name: file.name, isRaw, file, off, len, thumb, rot: 0 };
  };

  const loadFiles = async (fileList) => {
    setErr("");
    const files = Array.from(fileList);
    let done = 0, failed = 0;
    for (const file of files) {
      done++;
      setBusy(`Reading ${done}/${files.length} — ${file.name}`);
      await new Promise((r) => setTimeout(r, 0)); // keep the UI breathing
      try {
        const entry = await importOne(file);
        setImages((im) => [...im, entry]);
        setActiveId((cur) => cur || entry.id);
      } catch (e) {
        failed++;
        setErr(`Couldn't open ${file.name} — ${e.message}${failed > 1 ? ` (${failed} files skipped)` : ""}`);
      }
    }
    setBusy("");
  };

  const rotate = () => {
    if (!active) return;
    setImages((ims) => ims.map((im) => im.id === active.id ? { ...im, rot: (im.rot + 1) % 4 } : im));
    setCrops((c) => { const n = { ...c }; delete n[active.id]; return n; });
    setCropMode(false);
  };

  const removePhoto = (id) => {
    setImages((ims) => {
      const next = ims.filter((im) => im.id !== id);
      if (id === activeId) setActiveId(next.length ? next[0].id : null);
      return next;
    });
    for (const k of [...previewCache.current.keys()]) if (k.startsWith(id + ":")) previewCache.current.delete(k);
    setAdjust((a) => { const n = { ...a }; delete n[id]; return n; });
    setCrops((c) => { const n = { ...c }; delete n[id]; return n; });
  };

  /* ---------- Resizable side panels ---------- */

  const endResize = () => {
    resizeRef.current = null;
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onResize);
    window.removeEventListener("pointerup", endResize);
  };

  const onResize = (e) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.startX;
    if (r.side === "strip") setStripW(clamp(r.startW + dx, 90, 340));
    else setPanelW(clamp(r.startW - dx, 250, 560));
  };

  const startResize = (e, side) => {
    e.preventDefault();
    resizeRef.current = { side, startX: e.clientX, startW: side === "strip" ? stripW : panelW };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onResize);
    window.addEventListener("pointerup", endResize);
  };

  /* ---------- Crop ---------- */

  const aspectRatio = (val = cropAspect) => {
    if (!pv || val === "0") return null;
    if (val === "orig") return pv.width / pv.height;
    return parseFloat(val);
  };

  const conform = (cr, ratio) => {
    if (!ratio || !pv) return cr;
    const W = pv.width, H = pv.height;
    let { x, y, w, h } = cr;
    const cx = x + w / 2, cy = y + h / 2;
    h = (w * W) / (ratio * H);
    if (h > 1) { h = 1; w = (ratio * h * H) / W; }
    if (w > 1) { w = 1; h = (w * W) / (ratio * H); }
    x = clamp(cx - w / 2, 0, 1 - w);
    y = clamp(cy - h / 2, 0, 1 - h);
    return { x, y, w, h };
  };

  const toggleCrop = () => {
    if (!active || !pv) return;
    if (!cropMode) {
      setCrops((c) => c[active.id]
        ? c
        : { ...c, [active.id]: conform({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, aspectRatio()) });
    }
    setCropMode((m) => !m);
  };

  const clearCrop = () => {
    if (!active) return;
    setCrops((c) => { const n = { ...c }; delete n[active.id]; return n; });
    setCropNote((n) => ({ ...n, [active.id]: "" }));
    setCropMode(false);
  };

  const onAspectChange = (val) => {
    setCropAspect(val);
    if (active && crops[active.id]) {
      const r = aspectRatio(val);
      setCrops((c) => ({ ...c, [active.id]: conform(c[active.id], r) }));
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", endDrag);
  };

  const onDrag = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const px = clamp((e.clientX - d.rect.left) / d.rect.width, 0, 1);
    const py = clamp((e.clientY - d.rect.top) / d.rect.height, 0, 1);
    let cr;
    if (d.mode === "move") {
      cr = {
        ...d.start,
        x: clamp(d.start.x + (px - d.px0), 0, 1 - d.start.w),
        y: clamp(d.start.y + (py - d.py0), 0, 1 - d.start.h),
      };
    } else {
      const west = d.mode.includes("w"), north = d.mode.includes("n");
      const ax = west ? d.start.x + d.start.w : d.start.x;
      const ay = north ? d.start.y + d.start.h : d.start.y;
      let w = clamp(west ? ax - px : px - ax, 0.05, west ? ax : 1 - ax);
      let h = clamp(north ? ay - py : py - ay, 0.05, north ? ay : 1 - ay);
      if (d.ratio) {
        h = (w * d.W) / (d.ratio * d.H);
        const maxH = north ? ay : 1 - ay;
        if (h > maxH) { h = maxH; w = (d.ratio * h * d.H) / d.W; }
        if (h < 0.05) { h = 0.05; w = (d.ratio * h * d.H) / d.W; }
      }
      cr = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
    }
    setCrops((c) => ({ ...c, [d.id]: cr }));
  };

  const startDrag = (e, mode) => {
    if (!active || !crops[active.id] || !pv) return;
    e.preventDefault(); e.stopPropagation();
    const rect = viewWrapRef.current.getBoundingClientRect();
    dragRef.current = {
      id: active.id, mode, rect,
      start: { ...crops[active.id] },
      px0: (e.clientX - rect.left) / rect.width,
      py0: (e.clientY - rect.top) / rect.height,
      ratio: aspectRatio(),
      W: pv.width, H: pv.height,
    };
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", endDrag);
  };

  /* ---------- Preview render loop ---------- */

  useEffect(() => {
    if (!pv || !canvasRef.current) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const out = showOrig ? pv : develop(pv, params);
      const tmp = document.createElement("canvas");
      tmp.width = pv.width; tmp.height = pv.height;
      tmp.getContext("2d").putImageData(out, 0, 0);
      const cv = canvasRef.current;
      const cr = crops[activeId];
      if (cr && !cropMode && !showOrig) {
        cv.width = Math.max(1, Math.round(cr.w * pv.width));
        cv.height = Math.max(1, Math.round(cr.h * pv.height));
        cv.getContext("2d").drawImage(
          tmp, cr.x * pv.width, cr.y * pv.height, cr.w * pv.width, cr.h * pv.height,
          0, 0, cv.width, cv.height);
      } else {
        cv.width = pv.width; cv.height = pv.height;
        cv.getContext("2d").drawImage(tmp, 0, 0);
      }
      drawHistogram(out);
    });
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePreview, JSON.stringify(params), showOrig, cropMode,
      cropMode ? "editing" : JSON.stringify(crops[activeId] || null)]);

  const drawHistogram = (img) => {
    const h = histRef.current;
    if (!h) return;
    const bins = new Float32Array(64);
    const d = img.data;
    for (let i = 0; i < d.length; i += 16) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      bins[Math.min(63, L / 4 | 0)]++;
    }
    const mx = Math.max(...bins) || 1;
    const ctx = h.getContext("2d");
    ctx.clearRect(0, 0, h.width, h.height);
    ctx.fillStyle = "rgba(10,10,10,0.55)";
    ctx.fillRect(0, 0, h.width, h.height);
    ctx.fillStyle = "rgba(232,168,84,0.85)";
    const bw = h.width / 64;
    for (let i = 0; i < 64; i++) {
      const bh = Math.pow(bins[i] / mx, 0.5) * (h.height - 4);
      ctx.fillRect(i * bw, h.height - bh, bw - 0.5, bh);
    }
  };

  /* ---------- AI: develop & crop ---------- */

  const proxyFrom = (img) => {
    const big = document.createElement("canvas");
    big.width = img.width; big.height = img.height;
    big.getContext("2d").putImageData(img, 0, 0);
    return scaleInto(big, 720).toDataURL("image/jpeg", 0.82).split(",")[1];
  };
  const proxyB64 = () => proxyFrom(pv);

  const extractJson = (text) => {
    const cleaned = text.replace(/```json|```/g, "").trim();
    try { return JSON.parse(cleaned); } catch { /* fall through */ }
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("reply contained no JSON");
  };

  // Shared request builder: artifact mode relies on the platform; standalone
  // mode sends the user's own key straight to Anthropic from the browser.
  const apiRequest = (body) => {
    const headers = { "Content-Type": "application/json" };
    let model = "claude-sonnet-4-6";
    if (STANDALONE) {
      const key = readStore(KEY_STORE);
      if (!key) {
        const e = new Error("no API key set — open Settings (⚙) and paste your Anthropic key");
        e.noRetry = true;
        throw e;
      }
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      model = readStore(MODEL_STORE) || DEFAULT_MODEL;
    }
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, max_tokens: 1000, ...body }),
    });
  };

  const callClaude = async (b64, text, attempt = 0) => {
    try {
      const response = await apiRequest({
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            { type: "text", text },
          ],
        }],
      });
      const data = await response.json();
      if (data.error) {
        const e = new Error(data.error.message || data.error.type || "API error");
        // bad/revoked key or no access — retrying can't help
        if (response.status === 401 || response.status === 403 ||
            data.error.type === "authentication_error" || data.error.type === "permission_error") e.noRetry = true;
        throw e;
      }
      const out = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (!out.trim()) throw new Error("empty reply from the model");
      return extractJson(out);
    } catch (e) {
      // transient failures (rate limits, momentary overload, a malformed
      // reply) are common mid-batch — back off and retry before giving up
      if (!e.noRetry && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        return callClaude(b64, text, attempt + 1);
      }
      throw e;
    }
  };

  /* ---------- Settings (standalone key management) ---------- */

  useEffect(() => {
    if (!STANDALONE) return;
    setHasKey(!!readStore(KEY_STORE));
    setModelInput(readStore(MODEL_STORE) || DEFAULT_MODEL);
  }, []);

  const keyOk = () => {
    if (!STANDALONE || readStore(KEY_STORE)) return true;
    setErr("Add your Anthropic API key in Settings (⚙) first — the AI features need it.");
    setShowSettings(true);
    return false;
  };

  const saveSettings = () => {
    const k = keyInput.trim();
    if (k && !k.startsWith("sk-ant-")) {
      setKeyMsg("That doesn't look like an Anthropic key (they start with sk-ant-).");
      return false;
    }
    let ok = true;
    if (k) ok = writeStore(KEY_STORE, k);
    ok = writeStore(MODEL_STORE, modelInput.trim() === DEFAULT_MODEL ? "" : modelInput.trim()) && ok;
    setHasKey(!!readStore(KEY_STORE));
    setKeyInput("");
    setShowKey(false);
    setKeyMsg(ok ? "Saved to this browser." : "Couldn't save — this browser is blocking local storage (private mode?).");
    if (ok) setErr("");
    return ok;
  };

  const clearKey = () => {
    writeStore(KEY_STORE, "");
    setHasKey(false);
    setKeyInput("");
    setKeyMsg("Key removed from this browser.");
  };

  const testKey = async () => {
    setKeyMsg("Testing…");
    try {
      if (keyInput.trim() && !saveSettings()) return;
      const res = await apiRequest({ max_tokens: 8, messages: [{ role: "user", content: "Reply with: ok" }] });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || data.error.type);
      setKeyMsg("✓ Key works — AI features are ready.");
    } catch (e) {
      setKeyMsg("Test failed — " + e.message);
    }
  };

  const aiDevelop = async () => {
    if (!active || !pv) return;
    setBusy("Claude is reading the frame…");
    setErr("");
    try {
      const j = await callClaude(proxyB64(),
`You are a professional photographer developing a raw file. This is the straight-out-of-camera rendering. Propose subtle, ORGANIC corrections only — optimise lighting, white balance, tonal range and clarity for the subject and scene, as a careful photographer would in Lightroom. Do not stylise; keep it natural and faithful. Prefer small values; use larger ones only when the frame clearly needs them (e.g. badly underexposed).

Respond with ONLY a JSON object, no markdown fences, exactly these keys:
{"exposure": float -3..3 (EV), "contrast": int -100..100, "highlights": int -100..100, "shadows": int -100..100, "whites": int -100..100, "blacks": int -100..100, "temperature": int -100..100 (positive=warmer), "tint": int -100..100 (positive=magenta), "vibrance": int -100..100, "saturation": int -100..100, "sharpen": int 0..100, "rationale": "one or two sentences, in a photographer's voice, on what you corrected and why"}`);
      const next = { ...DEFAULTS };
      for (const k of Object.keys(DEFAULTS)) if (k in j && typeof j[k] !== "object") next[k] = j[k];
      next.mono = false; next.tone = null;
      setAdjust((a) => ({ ...a, [active.id]: next }));
      setAiNote((n) => ({ ...n, [active.id]: j.rationale || "" }));
    } catch (e) {
      setErr("AI develop failed — " + e.message);
    }
    setBusy("");
  };

  const aiCrop = async () => {
    if (!active || !pv) return;
    setBusy("Claude is studying the composition…");
    setErr("");
    try {
      const j = await callClaude(proxyB64(),
`You are a professional photographer refining composition. Suggest ONE crop for this frame. Principles: place the subject deliberately (rule of thirds or centred where it suits), trim dead space and edge distractions, preserve breathing room and context, respect the horizon. Be conservative — a good crop usually keeps most of the frame; only crop aggressively if the composition clearly demands it. If the frame is already well composed, return a near-full crop.

Respond with ONLY a JSON object, no markdown fences:
{"x": float 0-1, "y": float 0-1, "w": float 0-1, "h": float 0-1, "rationale": "one or two sentences, in a photographer's voice, on the compositional intent"}
x,y is the crop's top-left corner and w,h its size, all as fractions of the image dimensions. Ensure x+w<=1 and y+h<=1.`);
      let cr = {
        x: clamp(+j.x || 0, 0, 0.95),
        y: clamp(+j.y || 0, 0, 0.95),
        w: clamp(+j.w || 1, 0.05, 1),
        h: clamp(+j.h || 1, 0.05, 1),
      };
      cr.w = Math.min(cr.w, 1 - cr.x);
      cr.h = Math.min(cr.h, 1 - cr.y);
      if (cropAspect !== "0") cr = conform(cr, aspectRatio());
      setCrops((c) => ({ ...c, [active.id]: cr }));
      setCropNote((n) => ({ ...n, [active.id]: j.rationale || "" }));
      setCropMode(true);
    } catch (e) {
      setErr("Crop suggestion failed — " + e.message);
    }
    setBusy("");
  };

  /* ---------- Export core (full-res decoded transiently) ---------- */

  const exportBlob = async (im, p, cr0, format, q, cap) => {
    const bmp = await decodeBitmap(previewBlob(im));
    // rotateCanvas returns bmp AS-IS when rotation is 0 — so the bitmap must
    // stay alive until after the draw below, and is closed only at the end
    const rotated = rotateCanvas(bmp, im.rot);
    const fw = rotated.width, fh = rotated.height;
    const cr = cr0 || { x: 0, y: 0, w: 1, h: 1 };
    const sw = Math.max(1, Math.round(cr.w * fw));
    const sh = Math.max(1, Math.round(cr.h * fh));
    let sc = Math.min(1, cap / Math.max(sw, sh));
    // iOS Safari enforces a hard canvas area limit (~16.7M pixels); a 24MP
    // frame exceeds it and fails silently, so scale within the ceiling
    const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (iOS) sc = Math.min(sc, Math.sqrt(16000000 / (sw * sh)));
    // Crop and scale FIRST, then develop — keeps peak memory low
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * sc));
    c.height = Math.max(1, Math.round(sh * sc));
    const ctx = c.getContext("2d");
    ctx.drawImage(rotated, cr.x * fw, cr.y * fh, sw, sh, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    const srcData = ctx.getImageData(0, 0, c.width, c.height);
    const out = await developAsync(srcData, p);
    ctx.putImageData(out, 0, 0);
    const ext = format === "image/png" ? "png" : format === "image/webp" ? "webp" : "jpg";
    const name = `${im.name.replace(/\.[^.]+$/, "")}_developed.${ext}`;
    const blob = await new Promise((res) =>
      c.toBlob(res, format, format === "image/png" ? undefined : q));
    if (!blob) throw new Error("frame too large for the browser to encode — pick a smaller export size");
    const withMeta = await withMetadata(blob, previewBlob(im), format);
    return { blob: withMeta, name, dims: `${c.width}×${c.height}` };
  };

  const doExport = async () => {
    if (!active) return;
    setBusy("Developing export…");
    setErr("");
    setExportOut((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null; });
    await new Promise((r) => setTimeout(r, 30));
    try {
      const cap = expSize === "full" ? Infinity : parseInt(expSize, 10);
      const res = await exportBlob(active, params, crops[active.id], fmt, quality / 100, cap);
      const url = URL.createObjectURL(res.blob);
      setExportOut({
        url, name: res.name, dims: res.dims,
        kb: res.blob.size > 1048576 ? (res.blob.size / 1048576).toFixed(1) + " MB" : Math.round(res.blob.size / 1024) + " KB",
      });
      // NOTE: no programmatic download — in this sandboxed frame a scripted
      // click blanks the page. Saving is a real user click on the link below.
    } catch (e) {
      setErr("Export failed — " + e.message);
    }
    setBusy("");
  };

  /* ---------- Automatic workflow (batch) ---------- */

  const setItem = (key, patch) =>
    setBatchItems((items) => items.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const sanitizeDevelop = (src) => {
    const dev = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (src && typeof src[k] === "number") dev[k] = src[k];
    dev.exposure = clamp(dev.exposure, -3, 3);
    for (const k of ["contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation"])
      dev[k] = clamp(dev[k], -100, 100);
    dev.sharpen = clamp(dev.sharpen, 0, 100);
    dev.mono = false; dev.tone = null; // no looks in the automatic pass — add manually later
    return dev;
  };

  const sanitizeCrop = (j) => {
    if (!j) return null;
    const cr = {
      x: clamp(+j.x || 0, 0, 0.95),
      y: clamp(+j.y || 0, 0, 0.95),
      w: clamp(+j.w || 1, 0.05, 1),
      h: clamp(+j.h || 1, 0.05, 1),
    };
    cr.w = Math.min(cr.w, 1 - cr.x);
    cr.h = Math.min(cr.h, 1 - cr.y);
    // a near-full crop isn't worth applying
    if (cr.w > 0.985 && cr.h > 0.985) return null;
    return cr;
  };

  const runBatch = async (fileList) => {
    if (batchRunning) return;
    if (!keyOk()) return;
    setErr("");
    cancelRef.current = false;
    setBatchSummary(null);
    setZipOut((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null; });

    // Snapshot BEFORE any await — a live FileList from an input can be
    // cleared out from under us once the input is reset
    const allFiles = fileList ? Array.from(fileList) : null;
    if (allFiles && !allFiles.length) {
      setErr("The folder picker returned no files — your browser may not support folder selection here. Use 'Open photos' to multi-select the files instead, then run the batch on the current roll.");
      return;
    }

    // Ask for the output folder FIRST (needs the user-gesture; Chrome/Edge
    // desktop write straight into it, everywhere else we fall back to a zip)
    let dirHandle = null;
    try {
      if (window.showDirectoryPicker) dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch { dirHandle = null; }
    setBatchDest(dirHandle ? `output folder — ${dirHandle.name}` : "zip archive (folder saving unavailable here)");

    // Assemble the worklist: a chosen folder's images, or the current roll
    let entries = [];
    if (allFiles) {
      const files = allFiles.filter((f) => {
        const ext = (f.name.split(".").pop() || "").toLowerCase();
        return RAW_EXT.includes(ext) || IMG_EXT.includes(ext) || (f.type || "").startsWith("image/");
      });
      if (!files.length) {
        const seen = [...new Set(allFiles.slice(0, 40).map((f) => (f.name.split(".").pop() || "?").toLowerCase()))].join(", ");
        setErr(`Found ${allFiles.length} file${allFiles.length === 1 ? "" : "s"} in that folder but none look like photos (extensions seen: ${seen}). Supported: ${[...RAW_EXT, ...IMG_EXT].join(", ")}.`);
        return;
      }
      setBatchRunning(true);
      setBatchItems(files.map((f, i) => ({ key: "f" + i, name: f.name, status: "queued", info: "" })));
      let i = 0;
      for (const f of files) {
        const key = "f" + i++;
        if (cancelRef.current) break;
        setItem(key, { status: "reading" });
        setBusy(`Auto — reading ${i}/${files.length}`);
        await new Promise((r) => setTimeout(r, 0));
        try {
          const entry = await importOne(f);
          setImages((im) => [...im, entry]);   // everything joins the roll — nothing is lost
          setActiveId((cur) => cur || entry.id);
          entries.push({ key, entry });
          setItem(key, { status: "queued" });
        } catch (e) {
          setItem(key, { status: "failed", info: e.message });
        }
      }
    } else {
      if (!images.length) { setErr("The roll is empty — open some photos first."); return; }
      setBatchRunning(true);
      setBatchItems(images.map((im) => ({ key: im.id, name: im.name, status: "queued", info: "" })));
      entries = images.map((im) => ({ key: im.id, entry: im }));
    }

    const zipFiles = [];
    const usedNames = new Set();
    let saved = 0, filtered = 0, failed = 0, n = 0;

    for (const { key, entry } of entries) {
      n++;
      if (cancelRef.current) { setItem(key, { status: "skipped", info: "cancelled" }); continue; }
      setBusy(`Auto ${n}/${entries.length}`);
      if (n > 1) await new Promise((r) => setTimeout(r, 600)); // pace calls to stay under rate limits
      try {
        setItem(key, { status: "analysing" });
        const img = await decodePreview(entry);
        const j = await callClaude(proxyFrom(img), BATCH_PROMPT);

        if (j.verdict === "reject") {
          filtered++;
          setItem(key, { status: "filtered", info: j.reason || "" });
          continue; // stays in the roll for manual rescue — just not exported
        }

        const dev = sanitizeDevelop(j.develop);
        const cr = batchCropOn ? sanitizeCrop(j.crop) : null;

        // Mirror results into the manual editor — every frame stays adjustable
        setAdjust((a) => ({ ...a, [entry.id]: dev }));
        if (cr) setCrops((c) => ({ ...c, [entry.id]: cr }));
        setAiNote((nn) => ({ ...nn, [entry.id]: j.rationale || "" }));

        setItem(key, { status: "developing" });
        await new Promise((r) => setTimeout(r, 0));
        const res = await exportBlob(entry, dev, cr, "image/jpeg", batchQ / 100, Infinity);
        let outName = res.name;
        let dupe = 2;
        while (usedNames.has(outName)) outName = res.name.replace(/\.jpg$/, `_${dupe++}.jpg`);
        usedNames.add(outName);

        if (dirHandle) {
          const fh = await dirHandle.getFileHandle(outName, { create: true });
          const w = await fh.createWritable();
          await w.write(res.blob);
          await w.close();
        } else {
          zipFiles.push({ name: outName, u8: new Uint8Array(await res.blob.arrayBuffer()) });
        }
        saved++;
        setItem(key, { status: "saved", info: res.dims });
      } catch (e) {
        failed++;
        setItem(key, { status: "failed", info: e.message });
      }
    }

    if (!dirHandle && zipFiles.length) {
      const blob = makeZip(zipFiles);
      setZipOut({
        url: URL.createObjectURL(blob),
        size: (blob.size / 1048576).toFixed(1) + " MB",
        count: zipFiles.length,
      });
    }
    setBatchSummary({ saved, filtered, failed, toFolder: !!dirHandle, cancelled: cancelRef.current });
    setBatchRunning(false);
    setBusy("");
  };

  const resetBatch = () => {
    setBatchItems([]);
    setBatchSummary(null);
    setBatchDest("");
    setZipOut((prev) => { if (prev) URL.revokeObjectURL(prev.url); return null; });
  };

  /* ---------- UI ---------- */

  const Slider = ({ k, label, min, max, step }) => (
    <div className="sl">
      <div className="slrow">
        <span className="sllabel" onDoubleClick={() => setParam(k, DEFAULTS[k])}>{label}</span>
        <span className="slval">{k === "exposure" ? Number(params[k]).toFixed(2) : Math.round(params[k])}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={params[k]}
        onChange={(e) => setParam(k, parseFloat(e.target.value))} />
    </div>
  );

  return (
    <div className="latent">
      <style>{css}</style>

      <header>
        <div className="mark">
          <span className="wordmark">Latent</span>
          <span className="tag">non-destructive photo developer</span>
        </div>
        <div className="modeswitch">
          <button className={"btn seg" + (mode === "develop" ? " segon" : "")} onClick={() => setMode("develop")}>Develop</button>
          <button className={"btn seg" + (mode === "batch" ? " segon" : "")} onClick={() => setMode("batch")}>Auto batch</button>
        </div>
        <div className="hdr-actions">
          {busy && <span className="busy">{busy}</span>}
          {images.length > 0 && <span className="count">{images.length} photo{images.length === 1 ? "" : "s"}</span>}
          <button className="btn ghost" onClick={() => fileRef.current.click()}>Open photos</button>
          {STANDALONE && (
            <button className="btn ghost gear" title="Settings — API key" onClick={() => { setKeyMsg(""); setShowSettings(true); }}>
              ⚙{!hasKey && <span className="gdot" />}
            </button>
          )}
          <input ref={fileRef} type="file" multiple style={{ display: "none" }}
            accept=".cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,image/*"
            onChange={(e) => { const fl = Array.from(e.target.files); e.target.value = ""; loadFiles(fl); }} />
          <input ref={dirRef} type="file" multiple style={{ display: "none" }}
            onChange={(e) => { const fl = Array.from(e.target.files); e.target.value = ""; runBatch(fl); }} />
        </div>
      </header>

      {err && <div className="errbar">{err}</div>}

      {STANDALONE && !hasKey && !showSettings && (
        <div className="keybar">
          AI features need your Anthropic API key. Manual editing works without one.
          <button className="btn tiny" onClick={() => { setKeyMsg(""); setShowSettings(true); }}>Add key</button>
        </div>
      )}

      {STANDALONE && showSettings && (
        <div className="modalbg" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="mtitle">Settings</h3>
            <p className="mut small">
              Your Anthropic API key is stored <strong>only in this browser</strong> and sent only to
              api.anthropic.com. It is never part of the hosted app or its code, so sharing the URL
              doesn't share your key. Use a dedicated key with a spend limit, and enter it once per device.
            </p>
            <label className="flabel">API key {hasKey && <span className="okpill">saved</span>}</label>
            <div className="keyrow">
              <input className="tinput" type={showKey ? "text" : "password"} value={keyInput}
                placeholder={hasKey ? "•••••••• (leave blank to keep current)" : "sk-ant-…"}
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                onChange={(e) => setKeyInput(e.target.value)} />
              <button className="btn tiny" onClick={() => setShowKey((v) => !v)}>{showKey ? "hide" : "show"}</button>
            </div>
            <label className="flabel">Model</label>
            <input className="tinput" type="text" value={modelInput} autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={(e) => setModelInput(e.target.value)} />
            {keyMsg && <p className="keymsg">{keyMsg}</p>}
            <div className="mbtns">
              <button className="btn amber" onClick={saveSettings}>Save</button>
              <button className="btn" onClick={testKey}>Test key</button>
              {hasKey && <button className="btn" onClick={clearKey}>Remove key</button>}
              <button className="btn ghost" onClick={() => setShowSettings(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <div className="body" style={{ "--stripw": stripW + "px", "--panelw": panelW + "px" }}>
        {/* filmstrip */}
        <aside className="strip">
          {images.map((im) => (
            <div key={im.id} className={"th" + (im.id === activeId ? " on" : "")}>
              <button className="thbtn" onClick={() => { setActiveId(im.id); if (!batchRunning) setMode("develop"); }} title={im.name}>
                <img src={im.thumb} alt={im.name} loading="lazy" />
              </button>
              {im.isRaw && <span className="rawtag">RAW</span>}
              <button className="thx" title="Remove from roll" onClick={() => removePhoto(im.id)}>×</button>
            </div>
          ))}
          {images.length === 0 && <div className="stripempty">roll<br />empty</div>}
        </aside>

        <div className="rsz" title="Drag to resize" onPointerDown={(e) => startResize(e, "strip")} />

        {/* viewport */}
        <main className="view"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (mode === "develop") loadFiles(Array.from(e.dataTransfer.files)); }}>
          {mode === "batch" ? (
            <div className="batch">
              <h2 className="batchtitle">Automatic workflow</h2>
              <p className="mut small batchintro">
                Cull → develop → crop → save, hands-off. Obviously bad frames are filtered with a deliberately
                light touch — when in doubt, a photo is kept. No looks or filters are applied; every frame lands
                in the roll with its adjustments intact, so anything can be refined manually afterwards.
              </p>

              {batchItems.length === 0 ? (
                <>
                  <div className="batchset">
                    <label className="q">JPEG quality {batchQ}
                      <input type="range" min={70} max={100} value={batchQ}
                        onChange={(e) => setBatchQ(+e.target.value)} />
                    </label>
                    <label className="chk">
                      <input type="checkbox" checked={batchCropOn}
                        onChange={(e) => setBatchCropOn(e.target.checked)} /> auto-crop
                    </label>
                  </div>
                  <div className="batchstart">
                    <button className="btn amber" disabled={batchRunning} onClick={() => keyOk() && dirRef.current.click()}>
                      Choose a folder of photos…
                    </button>
                    <button className="btn" disabled={batchRunning || !images.length} onClick={() => runBatch(null)}>
                      Use the current roll{images.length ? ` (${images.length})` : ""}
                    </button>
                  </div>
                  <p className="mut small">
                    You'll be asked to pick an <em>output</em> folder first — on Chrome or Edge desktop the finished
                    JPEGs are written straight into it as they're developed. Elsewhere (or if you press Escape) the
                    run produces a single zip to save at the end. Frames are processed one at a time; a large roll
                    takes a while, and you can cancel at any point.
                  </p>
                </>
              ) : (
                <>
                  <div className="batchhead">
                    <span className="mut small">{batchDest}</span>
                    {batchRunning
                      ? <button className="btn" onClick={() => { cancelRef.current = true; }}>Cancel run</button>
                      : <button className="btn" onClick={resetBatch}>New run</button>}
                  </div>
                  <div className="batchlist">
                    {batchItems.map((it) => (
                      <div key={it.key} className="brow">
                        <span className={"chip " + it.status}>{
                          { queued: "·", reading: "…", analysing: "AI", developing: "dev",
                            saved: "✓", filtered: "cull", failed: "✗", skipped: "—" }[it.status] || it.status
                        }</span>
                        <span className="bname">{it.name}</span>
                        <span className="binfo mut">{it.info}</span>
                      </div>
                    ))}
                  </div>
                  {batchSummary && (
                    <div className="batchsum">
                      <p>
                        <strong>{batchSummary.saved}</strong> developed
                        · <strong>{batchSummary.filtered}</strong> filtered
                        {batchSummary.failed > 0 && <> · <strong>{batchSummary.failed}</strong> failed</>}
                        {batchSummary.cancelled && " · run cancelled"}
                      </p>
                      {batchSummary.toFolder
                        ? <p className="mut small">Finished JPEGs were written into your chosen folder as they completed.</p>
                        : zipOut && (
                          <a className="btn amber dl" href={zipOut.url} download="latent_developed.zip">
                            ↓ Save latent_developed.zip
                            <span className="dlmeta">{zipOut.count} photos · {zipOut.size}</span>
                          </a>
                        )}
                      <p className="mut small">
                        Filtered frames were <em>not</em> deleted — they're in the roll, marked "cull" above with the
                        reason, ready for manual rescue in Develop mode. Every exported frame's adjustments and crop
                        are also loaded in the editor if you want to refine any of them.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : active ? (
            pv ? (
              <>
                <div className="canvaswrap" ref={viewWrapRef}>
                  <canvas ref={canvasRef} className="frame" />
                  {cropMode && crop && (
                    <div className="cropov"
                      style={{ left: crop.x * 100 + "%", top: crop.y * 100 + "%", width: crop.w * 100 + "%", height: crop.h * 100 + "%" }}
                      onPointerDown={(e) => startDrag(e, "move")}>
                      <div className="g gv" style={{ left: "33.33%" }} />
                      <div className="g gv" style={{ left: "66.66%" }} />
                      <div className="g gh" style={{ top: "33.33%" }} />
                      <div className="g gh" style={{ top: "66.66%" }} />
                      {["nw", "ne", "sw", "se"].map((m) => (
                        <div key={m} className={"handle " + m} onPointerDown={(e) => startDrag(e, m)} />
                      ))}
                    </div>
                  )}
                </div>
                <canvas ref={histRef} width={200} height={56} className="hist" />
                <div className="viewtools">
                  <button className="btn tiny"
                    onMouseDown={() => setShowOrig(true)} onMouseUp={() => setShowOrig(false)}
                    onMouseLeave={() => setShowOrig(false)}
                    onTouchStart={() => setShowOrig(true)} onTouchEnd={() => setShowOrig(false)}>
                    {showOrig ? "original" : "hold · before"}
                  </button>
                  <button className="btn tiny" onClick={toggleCrop}>{cropMode ? "done ✓" : "crop"}</button>
                  <button className="btn tiny" onClick={rotate}>rotate ⟳</button>
                  <button className="btn tiny" onClick={() => { setAdjust((a) => ({ ...a, [activeId]: { ...DEFAULTS } })); setAiNote((n) => ({ ...n, [activeId]: "" })); }}>reset</button>
                </div>
                <div className="filename">{active.name}{active.isRaw ? " · embedded preview" : ""}</div>
              </>
            ) : (
              <div className="loading">
                <div className="aperture spin" />
                <p className="mut">developing preview…</p>
              </div>
            )
          ) : (
            <div className="drop" onClick={() => fileRef.current.click()}>
              <div className="drop-in">
                <div className="aperture" />
                <p><strong>Drop photos here</strong> or click to browse</p>
                <p className="mut">CR2 · CR3 · NEF · ARW · DNG · JPEG · PNG · WebP — large batches welcome</p>
                <p className="mut">Your files never leave this page except the small proxy sent for AI develop.</p>
              </div>
            </div>
          )}
        </main>

        <div className="rsz" title="Drag to resize" onPointerDown={(e) => startResize(e, "panel")} />

        {/* panel */}
        <aside className="panel">
          <section>
            <h3>AI develop</h3>
            <button className="btn amber wide" disabled={!pv || !!busy} onClick={aiDevelop}>
              Develop this frame
            </button>
            {activeId && aiNote[activeId] && <p className="note">“{aiNote[activeId]}”</p>}
            <p className="mut small">Claude reads the unedited frame and sets the sliders like a careful photographer — nothing is baked in; every value stays adjustable.</p>
          </section>

          <section>
            <h3>Light</h3>
            {SLIDERS.light.map(([k, l, mn, mx, st]) => <Slider key={k} k={k} label={l} min={mn} max={mx} step={st} />)}
          </section>

          <section>
            <h3>Colour</h3>
            {SLIDERS.colour.map(([k, l, mn, mx, st]) => <Slider key={k} k={k} label={l} min={mn} max={mx} step={st} />)}
          </section>

          <section>
            <h3>Crop</h3>
            <div className="croprow">
              <button className="btn" disabled={!pv} onClick={toggleCrop}>
                {cropMode ? "Done" : crop ? "Adjust" : "Crop"}
              </button>
              <select value={cropAspect} disabled={!pv} onChange={(e) => onAspectChange(e.target.value)}>
                <option value="0">Free</option>
                <option value="orig">Original</option>
                <option value="1">1 : 1</option>
                <option value="1.5">3 : 2</option>
                <option value="0.8">4 : 5</option>
                <option value="1.3333">4 : 3</option>
                <option value="1.7778">16 : 9</option>
                <option value="0.6667">2 : 3 (portrait)</option>
              </select>
            </div>
            <button className="btn amber wide" disabled={!pv || !!busy} onClick={aiCrop}>
              Suggest crop
            </button>
            {crop && (
              <button className="btn wide topgap" onClick={clearCrop}>Clear crop</button>
            )}
            {activeId && cropNote[activeId] && <p className="note">“{cropNote[activeId]}”</p>}
            <p className="mut small">Claude proposes a composition — the grid opens for review, so drag the corners to taste before pressing Done. The crop never discards pixels; clear it any time.</p>
          </section>

          <section>
            <h3>Looks</h3>
            <div className="presets">
              {PRESETS.map((pr) => (
                <button key={pr.name} className="btn preset" disabled={!pv}
                  onClick={() => setAdjust((a) => ({ ...a, [activeId]: { ...DEFAULTS, ...(a[activeId] || {}), ...pr.p } }))}>
                  {pr.name}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>Detail</h3>
            {SLIDERS.detail.map(([k, l, mn, mx, st]) => <Slider key={k} k={k} label={l} min={mn} max={mx} step={st} />)}
          </section>

          <section>
            <h3>Export</h3>
            <div className="exprow">
              <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
                <option value="image/jpeg">JPEG</option>
                <option value="image/webp">WebP</option>
                <option value="image/png">PNG (lossless)</option>
              </select>
              <select value={expSize} onChange={(e) => setExpSize(e.target.value)}>
                <option value="full">Full size</option>
                <option value="3000">3000 px</option>
                <option value="2000">2000 px</option>
                <option value="1200">1200 px</option>
              </select>
            </div>
            {fmt !== "image/png" && (
              <label className="q qrow">quality {quality}
                <input type="range" min={40} max={100} value={quality}
                  onChange={(e) => setQuality(+e.target.value)} />
              </label>
            )}
            <button className="btn wide" disabled={!pv || !!busy} onClick={doExport}>
              Develop export
            </button>
            {exportOut && (
              <>
                <a className="btn amber wide dl" href={exportOut.url} download={exportOut.name}>
                  ↓ Save {exportOut.name}
                  <span className="dlmeta">{exportOut.dims} · {exportOut.kb}</span>
                </a>
                <img className="expprev" src={exportOut.url} alt="Developed export — right-click or press and hold to save" />
                <p className="mut small">If the Save button is blocked here, right-click (desktop) or press-and-hold (mobile) the preview above and choose "Save image as…" — that path always works.</p>
              </>
            )}
            <p className="mut small">Exports are developed fresh from the untouched original. Files land in your browser's Downloads folder — to be asked for a location each time, enable "Ask where to save each file" in your browser's download settings.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap');

.latent{--bg:#151412;--bg2:#1c1a17;--line:#2a2723;--ink:#e8e3da;--mut:#8f887c;--amber:#e8a854;--amber-dk:#b57c2e;
 height:100vh;overflow:hidden;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif;font-size:14px;display:flex;flex-direction:column}
.latent *{box-sizing:border-box}

header{display:flex;align-items:center;justify-content:space-between;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--bg2)}
.wordmark{font-family:Fraunces,serif;font-size:22px;font-weight:600;letter-spacing:.02em;color:var(--amber)}
.tag{margin-left:12px;color:var(--mut);font-size:12px;letter-spacing:.06em}
.hdr-actions{display:flex;align-items:center;gap:12px}
.busy{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--amber)}
.count{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--mut)}
.gear{position:relative;font-size:16px;padding:4px 10px}
.gdot{position:absolute;top:3px;right:4px;width:7px;height:7px;border-radius:50%;background:var(--amber)}
.keybar{display:flex;align-items:center;gap:12px;background:#2a2316;color:var(--amber);padding:7px 18px;font-size:13px;border-bottom:1px solid #4a3a1c}
.modalbg{position:fixed;inset:0;background:rgba(8,7,6,.72);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
.modal{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:20px;width:100%;max-width:440px;max-height:92vh;overflow-y:auto}
.mtitle{font-family:Fraunces,serif;font-size:20px;font-weight:600;color:var(--amber);margin:0 0 8px}
.flabel{display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin:14px 0 6px}
.okpill{font-size:10px;letter-spacing:.06em;background:#233420;color:#9fd18a;padding:1px 6px;border-radius:3px;text-transform:none}
.keyrow{display:flex;gap:8px;align-items:center}
.tinput{flex:1;width:100%;background:var(--bg);color:var(--ink);border:1px solid #3a362f;border-radius:4px;padding:8px 10px;font-family:'IBM Plex Mono',monospace;font-size:13px;min-width:0}
.tinput:focus{outline:2px solid var(--amber-dk);outline-offset:1px}
.keymsg{font-size:12.5px;color:var(--amber);margin:12px 0 0;line-height:1.45}
.mbtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.errbar{background:#3a1f1a;color:#f0b8a8;padding:8px 18px;font-size:13px;border-bottom:1px solid #55291f}

.body{display:grid;grid-template-columns:var(--stripw,160px) 6px minmax(0,1fr) 6px var(--panelw,340px);flex:1;min-height:0;overflow:hidden}

.rsz{cursor:col-resize;background:var(--bg2);border-left:1px solid var(--line);touch-action:none;transition:background .15s}
.rsz:hover,.rsz:active{background:var(--amber-dk)}

.strip{padding:10px 8px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;min-height:0;background:var(--bg2)}
.stripempty{color:var(--mut);font-family:'IBM Plex Mono',monospace;font-size:10px;text-align:center;margin-top:20px;letter-spacing:.15em;text-transform:uppercase}
.th{position:relative;border:1px solid var(--line);border-radius:3px;overflow:hidden;flex:0 0 auto}
.thbtn{display:block;width:100%;background:none;border:none;padding:0;cursor:pointer;line-height:0}
.th img{width:100%;aspect-ratio:3/2;height:auto;object-fit:cover;display:block;opacity:.75;transition:opacity .15s}
.th.on{border-color:var(--amber)}.th.on img,.th:hover img{opacity:1}
.rawtag{position:absolute;top:3px;left:3px;background:rgba(0,0,0,.65);color:var(--amber);font-family:'IBM Plex Mono',monospace;font-size:9px;padding:1px 4px;border-radius:2px;letter-spacing:.08em;pointer-events:none}
.thx{position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;border:none;background:rgba(0,0,0,.6);color:var(--mut);font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s;padding:0}
.th:hover .thx{opacity:1}.thx:hover{color:var(--ink)}

.view{position:relative;display:flex;align-items:center;justify-content:center;padding:22px;min-width:0;min-height:0;overflow:hidden}
.canvaswrap{position:relative;display:inline-block;max-width:100%;line-height:0;overflow:hidden;border-radius:2px}
.frame{max-width:100%;max-height:calc(100vh - 130px);box-shadow:0 8px 40px rgba(0,0,0,.55);border-radius:2px;display:block}
.cropov{position:absolute;border:1px solid var(--amber);box-shadow:0 0 0 9999px rgba(10,9,7,.62);cursor:move;touch-action:none}
.cropov .g{position:absolute;background:rgba(232,168,84,.35);pointer-events:none}
.cropov .gv{top:0;bottom:0;width:1px}
.cropov .gh{left:0;right:0;height:1px}
.handle{position:absolute;width:14px;height:14px;background:var(--bg2);border:2px solid var(--amber);border-radius:50%;touch-action:none}
.handle.nw{left:-8px;top:-8px;cursor:nwse-resize}
.handle.se{right:-8px;bottom:-8px;cursor:nwse-resize}
.handle.ne{right:-8px;top:-8px;cursor:nesw-resize}
.handle.sw{left:-8px;bottom:-8px;cursor:nesw-resize}
.hist{position:absolute;left:26px;bottom:26px;border:1px solid var(--line);border-radius:3px}
.viewtools{position:absolute;right:26px;bottom:26px;display:flex;gap:8px}
.filename{position:absolute;top:10px;left:26px;color:var(--mut);font-family:'IBM Plex Mono',monospace;font-size:11px}
.loading{text-align:center}

.drop{width:100%;height:100%;min-height:300px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:8px;cursor:pointer}
.drop:hover{border-color:var(--amber-dk)}
.drop-in{text-align:center;color:var(--ink)}
.drop-in p{margin:6px 0}
.aperture{width:54px;height:54px;margin:0 auto 14px;border:2px solid var(--amber);border-radius:50%;position:relative}
.aperture:after{content:"";position:absolute;inset:12px;border:2px solid var(--amber-dk);border-radius:50%}
.aperture.spin{animation:latentspin 1.2s linear infinite;border-top-color:var(--amber-dk)}
@keyframes latentspin{to{transform:rotate(360deg)}}
.mut{color:var(--mut)} .small{font-size:12px;line-height:1.45}

.panel{overflow-y:auto;min-height:0;background:var(--bg2);padding-bottom:30px}
.panel section{padding:14px 16px;border-bottom:1px solid var(--line)}
.panel h3{margin:0 0 10px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--mut)}
.note{font-family:Fraunces,serif;font-style:italic;color:var(--amber);font-size:13.5px;line-height:1.5;margin:10px 0 4px}

.sl{margin-bottom:10px}
.slrow{display:flex;justify-content:space-between;margin-bottom:2px}
.sllabel{font-size:13px;cursor:default}
.slval{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--amber)}
input[type=range]{width:100%;appearance:none;height:2px;background:var(--line);border-radius:2px;outline:none}
input[type=range]::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border-radius:50%;background:var(--ink);border:2px solid var(--bg2);cursor:pointer}
input[type=range]:focus-visible::-webkit-slider-thumb{background:var(--amber)}

.btn{font-family:Inter,sans-serif;font-size:13px;background:var(--line);color:var(--ink);border:1px solid #3a362f;border-radius:4px;padding:7px 12px;cursor:pointer;transition:background .15s}
.btn:hover:not(:disabled){background:#34302a}
.btn:disabled{opacity:.45;cursor:default}
.btn:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.btn.wide{width:100%}
.btn.tiny{font-size:11px;padding:4px 9px;background:rgba(20,18,15,.8)}
.btn.ghost{background:transparent}
.btn.amber{background:var(--amber);border-color:var(--amber-dk);color:#1a1408;font-weight:500}
.btn.amber:hover:not(:disabled){background:#f0b465}
.presets{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.btn.preset{font-size:12px;padding:6px 4px}

.modeswitch{display:flex;gap:0;border:1px solid var(--line);border-radius:5px;overflow:hidden}
.btn.seg{border:none;border-radius:0;background:transparent;color:var(--mut);padding:6px 14px;font-size:12.5px}
.btn.seg.segon{background:var(--line);color:var(--amber)}

.batch{width:100%;max-width:620px;max-height:100%;overflow-y:auto;padding:8px 4px;align-self:flex-start;margin:auto}
.batchtitle{font-family:Fraunces,serif;font-weight:600;font-size:24px;color:var(--amber);margin:0 0 6px}
.batchintro{margin:0 0 16px}
.batchset{display:flex;align-items:center;gap:18px;margin-bottom:14px}
.chk{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--ink);cursor:pointer;white-space:nowrap}
.chk input{accent-color:var(--amber)}
.batchstart{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.batchhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
.batchlist{border:1px solid var(--line);border-radius:5px;max-height:44vh;overflow-y:auto;background:var(--bg2)}
.brow{display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12.5px}
.brow:last-child{border-bottom:none}
.chip{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.05em;min-width:38px;text-align:center;padding:2px 4px;border-radius:3px;background:var(--line);color:var(--mut);flex:0 0 auto}
.chip.saved{background:#233420;color:#9fd18a}
.chip.filtered{background:#38301c;color:var(--amber)}
.chip.failed{background:#3a1f1a;color:#f0b8a8}
.chip.analysing,.chip.developing,.chip.reading{background:var(--line);color:var(--ink)}
.bname{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.binfo{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;text-align:right}
.batchsum{margin-top:14px}
.batchsum p{margin:6px 0}
.croprow{display:flex;gap:8px;margin-bottom:8px}
.croprow select{flex:1;background:var(--line);color:var(--ink);border:1px solid #3a362f;border-radius:4px;padding:6px 8px;font-size:13px;min-width:0}
.topgap{margin-top:8px}

.exprow{display:flex;gap:10px;align-items:center;margin-bottom:10px}
.exprow select{flex:1;background:var(--line);color:var(--ink);border:1px solid #3a362f;border-radius:4px;padding:6px 8px;font-size:13px;min-width:0}
.q{display:flex;align-items:center;gap:6px;flex:1;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--mut)}
.qrow{margin-bottom:10px}
.dl{display:flex;flex-direction:column;align-items:center;gap:2px;text-decoration:none;margin-top:8px;padding:9px 12px}
.dlmeta{font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:400;opacity:.75}
.expprev{width:100%;display:block;border:1px solid var(--line);border-radius:4px;margin-top:8px}

@media (max-width:900px){
 .tinput{font-size:16px}
 .latent{height:auto;min-height:100vh;overflow:visible}
 .body{grid-template-columns:1fr !important;grid-template-rows:auto auto auto;overflow:visible}
 .rsz{display:none}
 .strip{flex-direction:row;border-bottom:1px solid var(--line);overflow-x:auto;overflow-y:hidden;height:78px;align-items:center;scrollbar-width:thin}
 .th{width:78px}
 .th img{height:54px;aspect-ratio:auto}
 .stripempty{margin:0 auto}
 .view{min-height:300px}
 .panel{border-top:1px solid var(--line);overflow-y:visible}
 .frame{max-height:60vh}
}
@media (prefers-reduced-motion:reduce){.latent *{transition:none!important;animation:none!important}}
`;
