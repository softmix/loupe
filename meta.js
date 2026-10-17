// Finds Stable Diffusion generation metadata in image bytes and boils it down to
// enough to decide whether the image is worth a closer look.
//
//   A1111 / Forge  PNG text "parameters"; JPEG/WebP EXIF UserComment, same text
//   ComfyUI        PNG text "prompt" (API graph JSON) + "workflow" (UI graph);
//                  WebP EXIF strings "prompt:{...}" / "workflow:{...}"
//   InvokeAI, SwarmUI, NovelAI are recognised by key and shown raw.
//
// Input is whatever a web server sent, so every read is bounds-checked or caught.

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const KEYS = ["parameters", "prompt", "workflow", "invokeai_metadata", "sui_image_params", "Comment"];

// tEXt is latin1 by spec, but plenty of writers put UTF-8 in it.
const text = b => { try { return utf8.decode(b); } catch { return latin1.decode(b); } };

async function inflate(b) {
  const s = new Blob([b]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function png(b, dv) {
  const out = {};
  for (let p = 8; p + 12 <= b.length; ) {
    const len = dv.getUint32(p), type = latin1.decode(b.subarray(p + 4, p + 8));
    const d = b.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IEND") break;
    const z = d.indexOf(0);
    if (z < 0 || !["tEXt", "zTXt", "iTXt"].includes(type)) continue;
    const key = latin1.decode(d.subarray(0, z));
    try {
      if (type === "tEXt") out[key] = text(d.subarray(z + 1));
      else if (type === "zTXt") out[key] = text(await inflate(d.subarray(z + 2)));
      else {
        // key \0 compressed method lang \0 translated-key \0 text
        const t = d.indexOf(0, d.indexOf(0, z + 3) + 1) + 1;
        out[key] = text(d[z + 1] ? await inflate(d.subarray(t)) : d.subarray(t));
      }
    } catch {}  // one corrupt chunk shouldn't hide the rest
  }
  return out;
}

function jpeg(b, dv) {
  const out = [];
  for (let p = 2; p + 4 <= b.length && b[p] === 0xff; ) {
    const m = b[p + 1], len = dv.getUint16(p + 2), d = b.subarray(p + 4, p + 2 + len);
    if (m === 0xda) break;  // start of scan: only pixels from here
    if (m === 0xe1 && latin1.decode(d.subarray(0, 6)) === "Exif\0\0") out.push(...exif(d.subarray(6)));
    if (m === 0xfe) out.push(text(d));
    p += 2 + len;
  }
  return out;
}

function webp(b, dv) {
  const out = [];
  for (let p = 12; p + 8 <= b.length; ) {
    const id = latin1.decode(b.subarray(p, p + 4)), len = dv.getUint32(p + 4, true);
    const d = b.subarray(p + 8, p + 8 + len);
    if (id === "EXIF") out.push(...exif(latin1.decode(d.subarray(0, 6)) === "Exif\0\0" ? d.subarray(6) : d));
    p += 8 + len + (len & 1);
  }
  return out;
}

// Every ASCII/UNDEFINED string in IFD0 and the Exif sub-IFD. Which tag a tool
// uses varies (A1111: UserComment, ComfyUI: Make/Model/ImageDescription), so
// fromStrings() decides by content rather than by tag.
function exif(b) {
  if (b.length < 8) return [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), le = b[0] === 0x49;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const out = [], seen = new Set();
  const walk = off => {
    if (!off || seen.has(off) || off + 2 > b.length) return;
    seen.add(off);
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > b.length) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === 0x8769) walk(u32(e + 8));
      else if (type === 2 || type === 7) {
        const start = count <= 4 ? e + 8 : u32(e + 8);
        const v = b.subarray(start, start + count);
        out.push(tag === 0x9286 ? userComment(v) : text(v).replace(/\0+$/, ""));
      }
    }
    if (off + 6 + n * 12 <= b.length) walk(u32(off + 2 + n * 12));
  };
  walk(u32(4));
  return out;
}

// 8-byte charset prefix, then text. piexif (A1111) writes UTF-16BE, others LE;
// the first character is ASCII in practice, so its zero byte gives it away.
function userComment(v) {
  const head = latin1.decode(v.subarray(0, 8)), body = v.subarray(8);
  if (head.startsWith("UNICODE")) return new TextDecoder(body[0] === 0 ? "utf-16be" : "utf-16le").decode(body);
  return text(head.startsWith("ASCII") || head === "\0".repeat(8) ? body : v);
}

function fromStrings(strs) {
  const out = {};
  for (const s of strs) {
    const m = s.match(/^(\w+):\s*([{[][\s\S]*)$/);
    if (m) out[m[1].toLowerCase()] = m[2];
    else if (/(^|\n)Steps: \d/.test(s)) out.parameters = s;
  }
  return out;
}

export async function readMeta(b) {
  let raw;
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const magic = latin1.decode(b.subarray(0, 12));
    if (b[0] === 0x89 && magic.startsWith("PNG", 1)) raw = await png(b, dv);
    else if (b[0] === 0xff && b[1] === 0xd8) raw = fromStrings(jpeg(b, dv));
    else if (magic.startsWith("RIFF") && magic.endsWith("WEBP")) raw = fromStrings(webp(b, dv));
    else return null;
  } catch { return null; }  // truncated or hostile input
  // "Comment" is also where GIMP & co. say hello; only NovelAI's has a prompt in it.
  const keep = Object.fromEntries(Object.entries(raw).filter(([k, v]) =>
    KEYS.includes(k) && v.trim() && (k !== "Comment" || v.includes('"prompt"'))));
  if (!Object.keys(keep).length) return null;
  return { raw: keep, ...summarize(keep) };
}

function summarize(raw) {
  if (raw.parameters && !raw.parameters.trimStart().startsWith("{")) return { kind: "a1111", ...a1111(raw.parameters) };
  if (raw.prompt) try { return { kind: "comfyui", ...comfy(JSON.parse(raw.prompt)) }; } catch {}
  return { kind: Object.keys(raw)[0], models: [], prompts: [] };
}

function a1111(s) {
  const i = s.search(/(^|\n)Steps: \d/);
  const head = i < 0 ? s : s.slice(0, i), settings = i < 0 ? "" : s.slice(i).trim();
  const [pos, neg = ""] = head.split(/(?:^|\n)Negative prompt:\s*/);
  const model = settings.match(/(?:^|, )Model: ([^,]+)/)?.[1];
  const loras = [...pos.matchAll(/<(?:lora|lyco):([^:>]+)/gi)].map(m => m[1]);
  return { models: [model, ...loras].filter(Boolean), prompts: [pos.trim()].filter(Boolean), negative: neg.trim(), settings };
}

// Node-agnostic: no list of class_types to keep current, just input names that
// mean "a model file" or "some text".
function comfy(graph) {
  const models = new Set(), prompts = new Set();
  for (const node of Object.values(graph)) {
    for (const [k, v] of Object.entries(node?.inputs ?? {})) {
      if (typeof v?.lora === "string") models.add(v.lora);  // rgthree Power Lora Loader
      if (typeof v !== "string" || !v.trim()) continue;
      if (/ckpt_name|unet_name|lora_name/.test(k)) models.add(v);
      else if (/text|prompt|positive|negative|^value$|^string/i.test(k)) prompts.add(v.trim());
    }
  }
  return { models: [...models], prompts: [...prompts] };
}
