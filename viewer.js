const bg = browser.extension.getBackgroundPage().loupe;
const list = document.getElementById("list");
const folder = document.getElementById("folder");

// Everything shown here came out of a stranger's image: textContent only, never innerHTML.
const el = (tag, props, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== ""));
  return e;
};

function card(h) {
  const status = el("span");
  const save = () => bg.save(h).then(() => status.textContent = "saved", e => status.textContent = e.message);
  return el("article", {},
    el("a", { href: h.url, target: "_blank" }, el("img", { src: h.src })),
    el("div", {},
      el("p", { className: "meta" }, `${h.kind} · `,
        el("a", { href: h.page, target: "_blank", textContent: new URL(h.page).host }),
        ` · ${new Date(h.time).toLocaleTimeString()}`),
      el("p", { className: "models" }, ...h.models.map(m => el("code", { textContent: m }))),
      ...h.prompts.map(p => el("p", { className: "prompt", textContent: p })),
      h.negative && el("p", { className: "neg", textContent: h.negative }),
      h.settings && el("p", { className: "settings", textContent: h.settings }),
      el("p", {}, el("button", { textContent: "Save", onclick: save }), " ", status),
      el("details", {}, el("summary", { textContent: "raw" }),
        ...Object.entries(h.raw).map(([k, v]) => el("pre", { textContent: `${k}:\n${v}` })))));
}

const shown = new WeakSet();
function render() {
  for (const h of [...bg.hits].reverse()) {
    if (shown.has(h)) continue;
    shown.add(h);
    document.getElementById("empty")?.remove();
    list.prepend(card(h));
  }
}

browser.storage.local.get("folder").then(s => folder.value = s.folder ?? "");
folder.onchange = () => browser.storage.local.set({ folder: folder.value.trim() || "loupe" });
browser.runtime.onMessage.addListener(m => { if (m === "hit") render(); });
render();
