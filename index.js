// bot.js
import { Telegraf } from "telegraf";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import process from "process";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      userDataDir: "/tmp/chrome-user-data",
      ignoreHTTPSErrors: true,
    });
  }
  return browserPromise;
}

// Reused configuration/constants from your server
const PRIORITY_DOMAINS = [
  "youtube.com", "youtu.be",
  "scontent", "cdninstagram",
  "fbcdn.net", "facebook.com",
  "twitter.com", "twimg.com",
  "soundcloud.com",
  "vimeo.com",
  "googlevideo.com",
  "play.google.com",
];

const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mkv|mp3|aac|ogg|opus|wav|flac|m4a|jpg|jpeg|png|gif|bmp|webp)(\?|$)/i;

// The injected page script (trimmed to essentials) - same approach as your /cdn
const INJECT_SCRIPT = `
(function () {
  const send = (obj) => {
    try { console.log("CAPTURE_MEDIA::" + JSON.stringify(obj)); } catch(e){}
  };

  // patch fetch
  try {
    const origFetch = window.fetch.bind(window);
    window.fetch = function(...args){
      const p = origFetch(...args);
      p.then(async (resp) => {
        try {
          const ct = resp.headers.get && resp.headers.get("content-type") || "";
          const u = resp.url || (args[0] || "");
          if (ct.includes("video") || ct.includes("audio") || ct.includes("image") || /m3u8|mpegurl|application\\/vnd\\.apple\\.mpegurl/i.test(ct) || (u && u.match(/\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|png|gif)/i))) {
            send({ type: "url", url: u, contentType: ct, note: "fetch" });
          }
          try {
            const clone = resp.clone();
            if ((ct && (ct.includes("video")||ct.includes("audio")||ct.includes("image"))) && typeof clone.blob === "function") {
              const b = await clone.blob();
              if (b && b.size && b.size < 200 * 1024) {
                const r = new FileReader();
                r.onload = () => send({ type: "dataurl", data: r.result, url: u, contentType: ct, note: "fetch-blob-small" });
                r.readAsDataURL(b);
              }
            }
          } catch(e){}
        } catch(e){}
      }).catch(()=>{});
      return p;
    };
  } catch(e){}

  // patch XHR
  try {
    const origOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url) {
      this._captureUrl = url;
      return origOpen.apply(this, arguments);
    };
    const origSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = function() {
      this.addEventListener && this.addEventListener("load", function() {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader("content-type") || "";
          const u = this._captureUrl || "";
          if (ct.includes("video") || ct.includes("audio") || ct.includes("image") || u.match(/\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|png|gif)/i)) {
            send({ type: "url", url: u, contentType: ct, note: "xhr" });
          }
          try {
            if (ct.includes("application/json") && this.responseText) {
              const trimmed = this.responseText.slice(0, 10000);
              send({ type: "maybe-json", url: u, preview: trimmed, note: "xhr-json-preview" });
            }
          } catch(e){}
        } catch(e){}
      });
      return origSend.apply(this, arguments);
    };
  } catch(e){}

  // observe DOM media
  try {
    const collect = () => {
      const out = [];
      document.querySelectorAll("video, audio").forEach(el => {
        const list = new Set();
        if (el.currentSrc) list.add(el.currentSrc);
        if (el.src) list.add(el.src);
        el.querySelectorAll && el.querySelectorAll("source").forEach(s => s.src && list.add(s.src));
        list.forEach(u => out.push({ type: el.tagName.toLowerCase(), url: u, note: "dom-element" }));
      });
      document.querySelectorAll("img").forEach(img => {
        if (img.src) out.push({ type: "image", url: img.src, note: "dom-img" });
      });
      if (out.length) send({ type: "dom-collection", items: out });
    };
    collect();
    const mo = new MutationObserver(() => collect());
    mo.observe(document, { childList: true, subtree: true });
  } catch(e){}
})();
`;

// helper to normalize and dedupe results
function normalizeAndSort(results) {
  const seen = new Set();
  const out = [];
  for (const obj of results) {
    if (!obj || !obj.url) continue;
    const key = obj.url + "|" + (obj.type || "");
    if (seen.has(key)) continue;
    seen.add(key);
    let t = obj.type || "media";
    if (t === "image" || (obj.contentType && obj.contentType.startsWith && obj.contentType.startsWith("image"))) t = "image";
    else if (t === "audio" || (obj.contentType && obj.contentType.startsWith && obj.contentType.startsWith("audio"))) t = "audio";
    else if (t === "video" || (obj.contentType && obj.contentType.startsWith && obj.contentType.startsWith("video"))) t = "video";
    else {
      if (obj.url.match(/\\.(mp4|webm|m3u8|mkv)/i)) t = "video";
      else if (obj.url.match(/\\.(mp3|aac|ogg|opus|wav|m4a|flac)/i)) t = "audio";
      else if (obj.url.match(/\\.(jpg|jpeg|png|gif|webp|bmp)/i)) t = "image";
    }
    out.push({
      url: obj.url,
      type: t,
      source: obj.source || obj.note || "detected",
      contentType: obj.contentType || null,
      title: obj.title || null,
    });
  }

  // priority sort
  const priority = [], normal = [];
  out.forEach(r => {
    if (PRIORITY_DOMAINS.some(d => (r.url || "").includes(d))) priority.push(r);
    else normal.push(r);
  });
  return [...priority, ...normal];
}

// core scraping function used by bot (based on your /cdn)
async function scrapeUrl(url, options = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // inject our script before page loads
  await page.evaluateOnNewDocument(INJECT_SCRIPT);

  const results = [];
  const seenConsole = new Set();

  // function to push result (used for console-messages)
  function pushResult(obj) {
    if (!obj || !obj.url) return;
    results.push(obj);
  }

  page.on("console", async (message) => {
    try {
      const txt = message.text();
      if (!txt || !txt.startsWith("CAPTURE_MEDIA::")) return;
      const payload = JSON.parse(txt.replace(/^CAPTURE_MEDIA::/, ""));
      if (payload.type === "url") {
        pushResult({ url: payload.url, contentType: payload.contentType, note: payload.note });
      } else if (payload.type === "dataurl") {
        pushResult({ url: payload.data, contentType: payload.contentType, note: payload.note });
      } else if (payload.type === "dom-collection" && Array.isArray(payload.items)) {
        payload.items.forEach(it => pushResult({ url: it.url, type: it.type, note: it.note }));
      } else if (payload.type === "maybe-json" && payload.preview) {
        const matches = (payload.preview || "").match(/https?:\\/\\/[^\\s"']+\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
        if (matches) matches.forEach(u => pushResult({ url: u, source: "json-preview" }));
      }
    } catch (e) {}
  });

  page.on("response", async (response) => {
    try {
      const rurl = response.url().replace(/&bytestart=\\d+&byteend=\\d+/gi, "");
      const headers = response.headers();
      const ct = headers["content-type"] || headers["Content-Type"] || "";
      if (ct && (ct.includes("video") || ct.includes("audio") || ct.includes("image") || /m3u8|mpegurl|application\\/vnd\\.apple\\.mpegurl/i.test(ct))) {
        pushResult({ url: rurl, contentType: ct, note: "network-response" });
      } else if (MEDIA_EXT_RE.test(rurl)) {
        pushResult({ url: rurl, note: "network-response-ext" });
      } else {
        const req = response.request();
        if (req && req.resourceType && req.resourceType() === "xhr" && ct && ct.includes && ct.includes("application/json")) {
          try {
            const json = await response.text();
            const matches = (json || "").match(/https?:\\/\\/[^\\s"']+\\.(mp4|webm|m3u8|mp3|aac|ogg|wav|jpg|jpeg|png|gif|webp)/gi);
            if (matches) matches.forEach(u => pushResult({ url: u, note: "xhr-json" }));
          } catch (e) {}
        }
      }
    } catch (e) {}
  });

  // try to navigate
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: options.timeout || 45000 }).catch(()=>{});
  } catch(e){}

  // explicit DOM scan
  try {
    const domMedia = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("video, audio").forEach(el => {
        const set = new Set();
        if (el.src) set.add(el.src);
        if (el.currentSrc) set.add(el.currentSrc);
        el.querySelectorAll && el.querySelectorAll("source").forEach(s => s.src && set.add(s.src));
        set.forEach(u => out.push({ url: u, tag: el.tagName.toLowerCase() }));
      });
      document.querySelectorAll("img").forEach(img => img.src && out.push({ url: img.src, tag: "img" }));
      document.querySelectorAll("source").forEach(s => s.src && out.push({ url: s.src, tag: "source" }));
      return out;
    });
    domMedia.forEach(d => pushResult({ url: d.url, type: d.tag === "img" ? "image" : undefined, note: "dom-scan" }));
  } catch(e){}

  // give dynamic scripts a bit of time to trigger hooks (short)
  await new Promise(r => setTimeout(r, options.wait || 2000));

  // page title
  let title = "Unknown";
  try { title = await page.title(); } catch(e){}

  // close page
  try { await page.close(); } catch(e){}

  // normalize and return
  const normalized = normalizeAndSort(results);
  normalized.forEach(r => r.title = title || "Unknown");
  return normalized;
}

// Telegram handlers
bot.start((ctx) => ctx.reply("Send me a URL or use /extract <url>. I will return audio/video/image CDN links found on the page."));

bot.command("extract", async (ctx) => {
  const input = ctx.message.text || "";
  const parts = input.split(" ").filter(Boolean);
  const url = parts[1] || parts[0] && parts[0].startsWith("/extract") ? parts.slice(1).join(" ") : null;
  if (!url) return ctx.reply("Usage: /extract https://example.com");
  await handleExtract(ctx, url);
});

bot.on("text", async (ctx) => {
  const text = (ctx.message && ctx.message.text || "").trim();
  // if text looks like URL, process
  if (/^https?:\\/\\//i.test(text)) {
    await handleExtract(ctx, text);
  } else {
    ctx.reply("Send a URL (starting with http/https) or use /extract <url>.");
  }
});

// main wrapper to handle Telegram UX + scraping
async function handleExtract(ctx, url) {
  const chatId = ctx.chat.id;
  const startMsg = await ctx.replyWithMarkdown(`🔎 Processing: ${url}\n_Status: starting..._\nYou will get results here when ready.`, { disable_web_page_preview: true });
  let editId = startMsg.message_id;

  // update status helper
  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, editId, undefined, text, { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch (e) { /* ignore edit failures */ }
  };

  try {
    await editStatus(`🔎 Processing: ${url}\n_Status: loading page and hooking network..._`);
    const results = await scrapeUrl(url, { timeout: 60000, wait: 2500 });

    if (!results || results.length === 0) {
      await editStatus(`✅ Done — no media links found for:\n${url}`);
      return;
    }

    await editStatus(`✅ Done — found *${results.length}* items. Sending summary...`);

    // send a compact list (limit first 40)
    const lines = results.slice(0, 40).map((r, i) => {
      const short = r.url.length > 120 ? r.url.slice(0, 110) + "…": r.url;
      return `*${i+1}.* [${r.type.toUpperCase()}] (${r.source})\n\`${short}\``;
    }).join("\n\n");

    await ctx.replyWithMarkdown(`*Results for:* ${url}\n\n${lines}`, { disable_web_page_preview: true });

    // send full JSON file as message (if large, send as document)
    const json = JSON.stringify(results, null, 2);
    if (json.length < 4000) {
      await ctx.replyWithMarkdown("`" + json.replace(/`/g, "'") + "`");
    } else {
      // send as file
      const buffer = Buffer.from(json, "utf8");
      await ctx.replyWithDocument({ source: buffer, filename: "media-results.json" }, { caption: `Full results (${results.length} items)` });
    }

    // send small image previews inline (first 3 images)
    const imageItems = results.filter(r => r.type === "image").slice(0, 3);
    for (const img of imageItems) {
      try {
        await ctx.replyWithPhoto({ url: img.url }, { caption: `${img.type} — ${img.source}` });
      } catch(e) { /* skip images that fail */ }
    }
  } catch (err) {
    console.error("Error in handleExtract:", err);
    await editStatus(`⚠️ Error while processing:\n${err && err.message ? err.message : String(err)}`);
  }
}

// graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

bot.launch().then(() => {
  console.log("Telegram bot started");
}).catch(err => {
  console.error("Failed to launch bot:", err);
});
