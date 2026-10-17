# loupe

Firefox extension that notices Stable Diffusion prompts embedded in images as
pages load them, and pops a notification. Click it (or the toolbar button) for a
list of hits: image, checkpoints and LoRAs, prompt text, raw metadata, and a Save
button that writes the original bytes, metadata intact, to `Downloads/<folder>`.

Reads A1111/Forge (`parameters` in PNG text or JPEG/WebP EXIF UserComment) and
ComfyUI (`prompt`/`workflow` in PNG text, `prompt:` strings in WebP EXIF).
InvokeAI, SwarmUI and NovelAI are recognised and shown raw.

Images are read off the network with `webRequest.filterResponseData`, so `<img>`,
CSS backgrounds, srcset, fetch() and direct image tabs all count, and nothing is
downloaded twice.

Doesn't see: `data:`/`blob:` URLs built in the page, responses a service worker
synthesises, images Firefox serves from its in-memory cache (a reload of a page
already seen), and anything a host has already stripped (Discord, most CDNs that
recompress, social sites).

`npm test` runs the parser tests; `npm run dev` launches Firefox with it loaded.
