import { readMeta } from "./meta.js";

// Images are read off the network as they arrive, via filterResponseData, so it
// doesn't matter how a page loads them -- <img>, CSS, srcset, fetch, a direct
// image tab -- and nothing is fetched twice. Bytes pass straight through; we
// keep a copy and parse it once the response ends.

const MAX_BYTES = 50e6;
const MAX_HITS = 100;  // ponytail: whole images held in memory, ~MAX_HITS × image size worst case
const hits = [];       // newest first
const seen = new Set();
let unseen = 0;

window.loupe = { hits, save, openViewer };  // for viewer.js, via getBackgroundPage()

browser.webRequest.onHeadersReceived.addListener(d => {
  if (d.statusCode !== 200 || seen.has(d.url)) return;
  const h = Object.fromEntries(d.responseHeaders.map(x => [x.name.toLowerCase(), x.value]));
  const type = h["content-type"] ?? "";
  if (!/^image\/(png|jpeg|webp)/i.test(type) || +h["content-length"] > MAX_BYTES) return;

  const f = browser.webRequest.filterResponseData(d.requestId);
  const parts = [];
  let size = 0;
  f.ondata = e => {
    f.write(e.data);
    if ((size += e.data.byteLength) <= MAX_BYTES) parts.push(e.data);
  };
  f.onstop = () => {
    f.close();
    if (size <= MAX_BYTES) inspect(d, new Blob(parts, { type })).catch(console.error);
  };
}, { urls: ["<all_urls>"] }, ["responseHeaders", "blocking"]);  // blocking, or filterResponseData says "Invalid request ID"

async function inspect(d, blob) {
  const meta = await readMeta(new Uint8Array(await blob.arrayBuffer()));
  if (!meta || seen.has(d.url)) return;
  seen.add(d.url);
  const hit = { ...meta, url: d.url, page: d.documentUrl ?? d.url, time: Date.now(), blob, src: URL.createObjectURL(blob) };
  hits.unshift(hit);
  for (const old of hits.splice(MAX_HITS)) URL.revokeObjectURL(old.src);
  console.log("loupe:", hit.kind, d.url);

  browser.browserAction.setBadgeText({ text: String(++unseen) });
  browser.notifications.create("loupe", {  // fixed id: a gallery page replaces one toast, not fifty
    type: "basic",
    iconUrl: "icon.svg",
    title: `${hit.kind} prompt${unseen > 1 ? ` (${unseen} new)` : ""}`,
    message: [hit.models.slice(0, 3).join(", "), hit.prompts[0]?.slice(0, 160)].filter(Boolean).join("\n") || hit.url,
  });
  browser.runtime.sendMessage("hit").catch(() => {});  // no viewer open is fine
}

async function openViewer() {
  unseen = 0;
  browser.browserAction.setBadgeText({ text: "" });
  const [view] = browser.extension.getViews({ type: "tab" });
  if (!view) return browser.tabs.create({ url: "viewer.html" });
  const tab = await view.browser.tabs.getCurrent();
  browser.tabs.update(tab.id, { active: true });
  browser.windows.update(tab.windowId, { focused: true });
}

// The downloads API can only write under the Downloads folder, hence a subfolder.
async function save(hit) {
  const { folder = "loupe" } = await browser.storage.local.get("folder");
  let name;
  try { name = decodeURIComponent(new URL(hit.url).pathname.split("/").pop()); } catch {}
  name = (name || "image").replace(/[\\/:*?"<>|]/g, "_");
  if (!/\.(png|jpe?g|webp)$/i.test(name)) name += "." + hit.blob.type.split("/")[1].split(";")[0];
  return browser.downloads.download({ url: hit.src, filename: `${folder}/${name}`, conflictAction: "uniquify" });
}

browser.browserAction.onClicked.addListener(openViewer);
browser.notifications.onClicked.addListener(openViewer);
