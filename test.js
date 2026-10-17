import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readMeta } from "./meta.js";

const enc = s => Buffer.from(s, "latin1");
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

const chunk = (type, data) => Buffer.concat([u32(data.length), enc(type), data, Buffer.alloc(4)]);
const png = (...chunks) => new Uint8Array(Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks, chunk("IEND", Buffer.alloc(0))]));

// Big-endian TIFF with one string entry, either in IFD0 or behind an Exif sub-IFD pointer.
function tiff(tag, type, data, sub) {
  const entry = off => Buffer.concat([u16(1), u16(tag), u16(type), u32(data.length), u32(off + 18), u32(0)]);
  return sub
    ? Buffer.concat([enc("MM\0\x2a"), u32(8), u16(1), u16(0x8769), u16(4), u32(1), u32(26), u32(0), entry(26), data])
    : Buffer.concat([enc("MM\0\x2a"), u32(8), entry(8), data]);
}

const A1111 = "a cat, <lora:catstyle:0.8>\nNegative prompt: dog\nSteps: 20, Sampler: Euler a, Model: dreamshaper_8, Size: 512x512";
const COMFY = JSON.stringify({
  4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
  6: { class_type: "CLIPTextEncode", inputs: { text: "a castle", clip: ["4", 1] } },
  9: { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
});

function assertA1111(m) {
  assert.equal(m.kind, "a1111");
  assert.deepEqual(m.models, ["dreamshaper_8", "catstyle"]);
  assert.deepEqual(m.prompts, ["a cat, <lora:catstyle:0.8>"]);
  assert.equal(m.negative, "dog");
  assert.match(m.settings, /^Steps: 20/);
}
function assertComfy(m) {
  assert.equal(m.kind, "comfyui");
  assert.deepEqual(m.models, ["sdxl.safetensors"]);
  assert.deepEqual(m.prompts, ["a castle"]);
}

test("a1111 png tEXt", async () => {
  assertA1111(await readMeta(png(chunk("tEXt", enc("parameters\0" + A1111)))));
});

test("comfyui png, compressed iTXt", async () => {
  const m = await readMeta(png(chunk("iTXt", Buffer.concat([enc("prompt\0\x01\0\0\0"), deflateSync(COMFY)]))));
  assertComfy(m);
});

test("a1111 jpeg, UTF-16BE UserComment in the Exif sub-IFD", async () => {
  const comment = Buffer.concat([enc("UNICODE\0"), Buffer.from(A1111, "utf16le").swap16()]);
  const exif = Buffer.concat([enc("Exif\0\0"), tiff(0x9286, 7, comment, true)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), u16(exif.length + 2), exif, Buffer.from([0xff, 0xda, 0, 2])]);
  assertA1111(await readMeta(new Uint8Array(jpg)));
});

test("comfyui webp, prompt:{...} in IFD0", async () => {
  const exif = tiff(0x0110, 2, enc("prompt:" + COMFY + "\0"), false);
  const body = Buffer.concat([enc("WEBP"), enc("VP8L"), u32le(2), Buffer.alloc(2), enc("EXIF"), u32le(exif.length), exif]);
  assertComfy(await readMeta(new Uint8Array(Buffer.concat([enc("RIFF"), u32le(body.length), body]))));
});

test("ordinary images and garbage are ignored without throwing", async () => {
  assert.equal(await readMeta(png(chunk("tEXt", enc("Software\0GIMP")), chunk("tEXt", enc("Comment\0hello")))), null);
  const full = png(chunk("tEXt", enc("parameters\0" + A1111)));
  for (let n = 0; n < full.length; n += 7) await readMeta(full.subarray(0, n));
  assert.equal(await readMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), null);
});
