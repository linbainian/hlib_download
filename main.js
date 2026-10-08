// ==UserScript==
// @name         hlib图书馆下载（新版）
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @license      MIT
// @description  下载 hlib 当前单章或整个系列，保留段落、缩进和分页结构
// @author       liepainian
// @match        https://hlib.cc/n/*
// @match        https://hlib.cc/s/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==
 
(function () {
  "use strict";
 
  // 隐藏加载器中的页面也会命中 @match；只允许顶层页面创建操作面板。
  if (window.top !== window.self) return;
 
  const CONFIG = {
    pageTimeout: 120000,
    retryDelay: 15000,
    maxRetries: 3,
    defaultPageDelay: 5,
    defaultChapterDelay: 10,
  };
 
  const state = {
    running: false,
    cancelled: false,
    iframe: null,
    loadSerial: 0,
  };
 
  GM_addStyle(`
    #hlib-dl-panel {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      width: 240px;
      padding: 12px;
      border: 1px solid rgba(127,127,127,.3);
      border-radius: 10px;
      background: rgba(255,255,255,.96);
      color: #212529;
      box-shadow: 0 4px 18px rgba(0,0,0,.18);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    #hlib-dl-panel * { box-sizing: border-box; }
    #hlib-dl-panel .hlib-dl-title { margin-bottom: 8px; font-weight: 700; }
    #hlib-dl-panel .hlib-dl-row { display: flex; gap: 8px; margin-top: 8px; }
    #hlib-dl-panel .hlib-dl-settings {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }
    #hlib-dl-panel label { color: #555; font-size: 12px; }
    #hlib-dl-panel input[type="number"] {
      width: 100%;
      height: 32px;
      margin-top: 3px;
      padding: 4px 6px;
      border: 1px solid #aaa;
      border-radius: 6px;
      background: #fff;
      color: #212529;
    }
    #hlib-dl-panel button {
      min-height: 34px;
      border: 1px solid #0d6efd;
      border-radius: 6px;
      background: #fff;
      color: #0d6efd;
      cursor: pointer;
    }
    #hlib-dl-panel button { flex: 1; padding: 6px 10px; }
    #hlib-dl-panel button.hlib-primary { background: #0d6efd; color: #fff; }
    #hlib-dl-panel button.hlib-danger { border-color: #dc3545; color: #dc3545; }
    #hlib-dl-panel button:disabled { cursor: not-allowed; opacity: .55; }
    #hlib-dl-status {
      margin-top: 8px;
      max-height: 84px;
      overflow: auto;
      color: #555;
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #hlib-range-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(0,0,0,.45);
    }
    #hlib-range-dialog {
      width: min(360px, 100%);
      padding: 18px;
      border-radius: 12px;
      background: #fff;
      color: #212529;
      box-shadow: 0 10px 35px rgba(0,0,0,.3);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    #hlib-range-dialog h3 { margin: 0 0 8px; font-size: 18px; }
    #hlib-range-dialog p { margin: 6px 0 12px; color: #555; }
    #hlib-range-dialog .hlib-range-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    #hlib-range-dialog label { color: #555; font-size: 13px; }
    #hlib-range-dialog input {
      width: 100%;
      height: 36px;
      margin-top: 4px;
      padding: 5px 8px;
      border: 1px solid #aaa;
      border-radius: 6px;
    }
    #hlib-range-dialog .hlib-range-actions { display: flex; gap: 10px; margin-top: 16px; }
    #hlib-range-dialog button {
      flex: 1;
      min-height: 36px;
      border: 1px solid #0d6efd;
      border-radius: 6px;
      background: #fff;
      color: #0d6efd;
      cursor: pointer;
    }
    #hlib-range-dialog button.hlib-primary { background: #0d6efd; color: #fff; }
    #hlib-range-error { min-height: 20px; margin-top: 8px; color: #dc3545; font-size: 12px; }
  `);
 
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
 
  function readNumberSetting(id, fallback, min, max) {
    const value = Number.parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }
 
  function getDelaySettings() {
    return {
      pageMs: readNumberSetting("hlib-page-delay", CONFIG.defaultPageDelay, 2, 60) * 1000,
      chapterMs: readNumberSetting("hlib-chapter-delay", CONFIG.defaultChapterDelay, 3, 180) * 1000,
    };
  }
 
  async function throttledWait(baseMs, label) {
    assertNotCancelled();
    // 在用户设置的最短间隔上增加 0%～35% 随机缓冲，避免固定频率连续访问。
    const actualMs = Math.round(baseMs * (1 + Math.random() * 0.35));
    const seconds = (actualMs / 1000).toFixed(1);
    setStatus(`${label}，等待 ${seconds} 秒……`);
    await sleep(actualMs);
    assertNotCancelled();
  }
 
  function assertNotCancelled() {
    if (state.cancelled) throw new Error("用户已取消下载");
  }
 
  function normalizeText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\t ]+\n/g, "\n")
      .replace(/\n[\t ]+\n/g, "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
  }
 
  function safeFilename(name) {
    return String(name || "hlib下载")
      .replace(/[\\/:*?"<>|\x00-\x1F]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 150) || "hlib下载";
  }
 
  function canonicalUrl(url, type) {
    const result = new URL(url, location.href);
    result.hash = "";
    result.search = "";
    if (type === "article" && !result.pathname.startsWith("/n/")) {
      throw new Error(`不是有效的文章地址：${result.pathname}`);
    }
    if (type === "series" && !result.pathname.startsWith("/s/")) {
      throw new Error(`不是有效的系列地址：${result.pathname}`);
    }
    return result.href;
  }
 
  function urlWithPage(url, page) {
    const result = new URL(url, location.href);
    // 必须显式传 p=1；不传时站点可能跳到用户上次读到的页码。
    result.searchParams.set("p", String(page));
    return result.href;
  }
 
  function getTotalPages(doc) {
    const documentUrl = new URL(doc.location?.href || location.href, location.href);
    const values = [
      ...[...doc.querySelectorAll("select[onchange*=\"rp('p'\"] option, select.form-select option")]
        .map((option) => Number.parseInt(option.value, 10)),
      ...[...doc.querySelectorAll('a[href*="p="]')]
        .map((a) => {
          const linkUrl = new URL(a.href, documentUrl);
          return linkUrl.pathname === documentUrl.pathname
            ? Number.parseInt(linkUrl.searchParams.get("p"), 10)
            : Number.NaN;
        }),
    ].filter((value) => Number.isFinite(value) && value > 0);
    return values.length ? Math.max(...values) : 1;
  }
 
  function isChallengePage(doc) {
    const title = doc?.title || "";
    const body = doc?.body?.innerText || "";
    return /请稍候|Just a moment/i.test(title) || /正在进行安全验证|security verification/i.test(body);
  }
 
  function ensureIframe() {
    if (state.iframe?.isConnected) return state.iframe;
    const iframe = document.createElement("iframe");
    iframe.id = "hlib-download-loader";
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = [
      "position:fixed",
      "right:0",
      "bottom:0",
      "width:2px",
      "height:2px",
      "opacity:.01",
      "pointer-events:none",
      "border:0",
      "z-index:-1",
    ].join(";");
    document.body.appendChild(iframe);
    state.iframe = iframe;
    return iframe;
  }
 
  function waitForDocument(url, expectedType) {
    assertNotCancelled();
    const iframe = ensureIframe();
    const serial = ++state.loadSerial;
    const startedAt = Date.now();
 
    return new Promise((resolve, reject) => {
      let timer = null;
 
      const finish = (error, doc) => {
        if (timer) clearInterval(timer);
        if (error) reject(error);
        else resolve(doc);
      };
 
      const inspect = () => {
        if (serial !== state.loadSerial) return finish(new Error("页面加载任务已被替换"));
        if (state.cancelled) return finish(new Error("用户已取消下载"));
 
        try {
          const doc = iframe.contentDocument;
          const pathname = iframe.contentWindow.location.pathname;
          const ready = doc?.readyState === "interactive" || doc?.readyState === "complete";
          const articleReady = expectedType === "article" && pathname.startsWith("/n/") && doc?.querySelector("#content");
          const seriesReady = expectedType === "series" && pathname.startsWith("/s/") && ready && !isChallengePage(doc);
 
          if (articleReady || seriesReady) return finish(null, doc);
          if (isChallengePage(doc)) setStatus("正在通过网站安全验证，请稍候……");
          if (ready && /\/login|\/signin/.test(pathname)) {
            return finish(new Error("当前登录状态失效，请先登录 hlib"));
          }
        } catch (error) {
          // 页面跳转期间可能短暂无法访问，继续等待即可。
        }
 
        if (Date.now() - startedAt > CONFIG.pageTimeout) {
          finish(new Error("页面加载超时；请确认已登录，并在浏览器中完成人机验证"));
        }
      };
 
      iframe.src = url;
      iframe.onload = inspect;
      timer = setInterval(inspect, 350);
      inspect();
    });
  }
 
  async function loadDocument(url, expectedType) {
    let lastError;
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        return await waitForDocument(url, expectedType);
      } catch (error) {
        lastError = error;
        if (state.cancelled || attempt >= CONFIG.maxRetries) break;
        setStatus(`页面加载失败，正在重试（${attempt + 1}/${CONFIG.maxRetries}）……`);
        await sleep(CONFIG.retryDelay);
      }
    }
    throw lastError;
  }
 
  function getArticleTitle(doc) {
    return normalizeText(
      doc.querySelector("h3.text-center")?.textContent ||
      doc.querySelector("main h1, main h2, main h3")?.textContent ||
      doc.title ||
      "未命名文章",
    );
  }
 
  function getAuthor(doc, contentText = "") {
    const contentMatch = contentText.match(/^作者[：:]\s*([^\n]+)/m);
    if (contentMatch) return normalizeText(contentMatch[1]);
 
    const candidates = [...doc.querySelectorAll('a[href^="/u/"]')]
      .map((a) => normalizeText(a.textContent))
      .filter(Boolean);
    return candidates[0] || "未知作者";
  }
 
  function parseArticlePage(doc) {
    const content = doc.querySelector("#content");
    if (!content) throw new Error("未找到正文 #content，页面可能仍在验证或文章尚未解锁");
    const text = normalizeText(content.innerText || content.textContent);
    if (!text) throw new Error("正文为空");
    return {
      title: getArticleTitle(doc),
      author: getAuthor(doc, text),
      text,
      totalPages: getTotalPages(doc),
    };
  }
 
  async function downloadArticleData(articleUrl, articleIndex, articleCount) {
    const baseUrl = canonicalUrl(articleUrl, "article");
    const pages = [];
    let title = "未命名文章";
    let author = "未知作者";
    let totalPages = 1;
 
    for (let page = 1; page <= totalPages; page++) {
      assertNotCancelled();
      setStatus(`正在读取第 ${articleIndex}/${articleCount} 章，第 ${page}/${totalPages} 页……`);
      const pageUrl = urlWithPage(baseUrl, page);
 
      let doc;
      const currentUrl = new URL(location.href);
      const requestedUrl = new URL(pageUrl);
      const currentPage = Number.parseInt(currentUrl.searchParams.get("p") || "1", 10);
      const isCurrentFirstPage = page === 1 &&
        currentUrl.pathname === requestedUrl.pathname &&
        currentPage === 1 &&
        document.querySelector("#content");
 
      doc = isCurrentFirstPage ? document : await loadDocument(pageUrl, "article");
      const parsed = parseArticlePage(doc);
      title = parsed.title || title;
      author = parsed.author || author;
      totalPages = Math.max(totalPages, parsed.totalPages);
      pages.push(parsed.text);
 
      if (page < totalPages) {
        await throttledWait(getDelaySettings().pageMs, `第 ${articleIndex}/${articleCount} 章当前分页完成`);
      }
    }
 
    return { url: baseUrl, title, author, pages };
  }
 
  function parseSeriesPage(doc) {
    const links = [...doc.querySelectorAll('a[href^="/n/"]')]
      .map((a) => {
        const text = normalizeText(a.textContent);
        const match = text.match(/^#\s*(\d+)\s*(.*)$/s);
        return {
          url: canonicalUrl(a.href, "article"),
          text,
          order: match ? Number.parseInt(match[1], 10) : Number.POSITIVE_INFINITY,
        };
      })
      .filter((item) => Number.isFinite(item.order));
 
    const unique = [...new Map(links.map((item) => [new URL(item.url).pathname, item])).values()];
    return {
      title: normalizeText(doc.querySelector("h3.text-center, main h1, main h2, main h3")?.textContent || doc.title),
      author: getAuthor(doc),
      totalPages: getTotalPages(doc),
      articles: unique,
    };
  }
 
  async function getSeriesData(seriesUrl) {
    const baseUrl = canonicalUrl(seriesUrl, "series");
    const allArticles = [];
    let title = "未命名系列";
    let author = "未知作者";
    let totalPages = 1;
 
    for (let page = 1; page <= totalPages; page++) {
      assertNotCancelled();
      setStatus(`正在读取系列目录，第 ${page}/${totalPages} 页……`);
 
      const pageUrl = urlWithPage(baseUrl, page);
      const currentUrl = new URL(location.href);
      const requestedUrl = new URL(pageUrl);
      const currentPage = Number.parseInt(currentUrl.searchParams.get("p") || "1", 10);
      const isCurrentFirstPage = page === 1 &&
        currentUrl.pathname === requestedUrl.pathname &&
        currentPage === 1;
 
      const doc = isCurrentFirstPage ? document : await loadDocument(pageUrl, "series");
      const parsed = parseSeriesPage(doc);
      title = parsed.title || title;
      author = parsed.author || author;
      totalPages = Math.max(totalPages, parsed.totalPages);
      allArticles.push(...parsed.articles);
 
      if (page < totalPages) {
        await throttledWait(getDelaySettings().pageMs, "系列目录当前分页完成");
      }
    }
 
    const articles = [...new Map(allArticles.map((item) => [new URL(item.url).pathname, item])).values()]
      .sort((a, b) => a.order - b.order);
 
    if (!articles.length) throw new Error("系列页中没有找到以 #序号 开头的文章链接");
    return { url: baseUrl, title, author, articles };
  }
 
  function findSeriesLink(doc = document) {
    const candidates = [...doc.querySelectorAll('a[href^="/s/"]')];
    return candidates.find((a) => /系列[：:]?/.test(a.parentElement?.textContent || "")) || candidates[0] || null;
  }
 
  function chooseSeriesRange(total) {
    return new Promise((resolve) => {
      document.getElementById("hlib-range-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.id = "hlib-range-overlay";
      overlay.innerHTML = `
        <div id="hlib-range-dialog" role="dialog" aria-modal="true" aria-labelledby="hlib-range-title">
          <h3 id="hlib-range-title">选择系列下载范围</h3>
          <p>系列共 ${total} 章。默认下载全部章节。</p>
          <div class="hlib-range-inputs">
            <label>从第几章
              <input id="hlib-range-start" type="number" min="1" max="${total}" step="1" value="1">
            </label>
            <label>到第几章
              <input id="hlib-range-end" type="number" min="1" max="${total}" step="1" value="${total}">
            </label>
          </div>
          <div id="hlib-range-error"></div>
          <div class="hlib-range-actions">
            <button type="button" data-range-action="cancel">取消</button>
            <button type="button" class="hlib-primary" data-range-action="confirm">开始下载</button>
          </div>
        </div>
      `;
 
      const finish = (value) => {
        overlay.remove();
        resolve(value);
      };
 
      overlay.addEventListener("click", (event) => {
        const action = event.target.closest("button[data-range-action]")?.dataset.rangeAction;
        if (action === "cancel" || event.target === overlay) return finish(null);
        if (action !== "confirm") return;
 
        const start = Number.parseInt(overlay.querySelector("#hlib-range-start").value, 10);
        const end = Number.parseInt(overlay.querySelector("#hlib-range-end").value, 10);
        const error = overlay.querySelector("#hlib-range-error");
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > total || start > end) {
          error.textContent = `请输入 1～${total} 之间的有效范围，且起始章不能大于结束章。`;
          return;
        }
        finish({ start, end });
      });
 
      document.body.appendChild(overlay);
      overlay.querySelector("#hlib-range-start").focus();
    });
  }
 
  function buildTextExport(book) {
    const lines = [
      book.title,
      `作者：${book.author}`,
      `来源：${book.url}`,
      `导出时间：${new Date().toLocaleString()}`,
      "",
    ];
 
    book.articles.forEach((article, index) => {
      lines.push("=".repeat(64));
      lines.push(`第 ${article.order ?? index + 1} 章　${article.title}`);
      lines.push("=".repeat(64));
      lines.push("");
 
      article.pages.forEach((pageText, pageIndex) => {
        if (article.pages.length > 1) {
          lines.push(`—— 第 ${pageIndex + 1}/${article.pages.length} 页 ——`);
          lines.push("");
        }
        lines.push(pageText, "");
      });
      lines.push("");
    });
 
    // BOM + CRLF：兼容 Windows 记事本，并确保段落不会挤成一行。
    return "\uFEFF" + lines.join("\n").replace(/\n/g, "\r\n");
  }
 
  function saveFile(book) {
    const content = buildTextExport(book);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `${safeFilename(book.title)}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  }
 
  async function runTask(task) {
    if (state.running) return;
    state.running = true;
    state.cancelled = false;
    setControlsRunning(true);
 
    try {
      let book;
 
      if (task === "article") {
        const article = await downloadArticleData(location.href, 1, 1);
        book = {
          title: article.title,
          author: article.author,
          url: article.url,
          articles: [article],
        };
      } else {
        const seriesLink = location.pathname.startsWith("/s/")
          ? { href: location.href }
          : findSeriesLink();
        if (!seriesLink) throw new Error("当前文章没有检测到所属系列");
 
        const series = await getSeriesData(seriesLink.href);
        const range = await chooseSeriesRange(series.articles.length);
        if (!range) throw new Error("用户已取消下载");
        const selectedArticles = series.articles.slice(range.start - 1, range.end);
 
        const articles = [];
        const failures = [];
        for (let index = 0; index < selectedArticles.length; index++) {
          assertNotCancelled();
          try {
            const item = selectedArticles[index];
            const article = await downloadArticleData(item.url, index + 1, selectedArticles.length);
            article.order = item.order;
            articles.push(article);
          } catch (error) {
            failures.push(`#${selectedArticles[index].order}：${error.message}`);
          }
          if (index < selectedArticles.length - 1) {
            await throttledWait(getDelaySettings().chapterMs, `第 ${index + 1}/${selectedArticles.length} 章下载完成`);
          }
        }
 
        if (!articles.length) throw new Error(`系列全部下载失败：${failures.join("；")}`);
        book = {
          title: range.start === 1 && range.end === series.articles.length
            ? series.title
            : `${series.title}（第${range.start}-${range.end}章）`,
          author: articles[0]?.author || series.author,
          url: series.url,
          articles,
        };
        if (failures.length) {
          book.articles.push({
            title: "下载失败清单",
            author: "",
            pages: [failures.join("\n")],
            url: "",
          });
        }
      }
 
      assertNotCancelled();
      saveFile(book);
      setStatus(`下载完成：${book.articles.length} 章 TXT`);
    } catch (error) {
      console.error("[hlib下载器]", error);
      setStatus(error.message || String(error));
    } finally {
      state.running = false;
      setControlsRunning(false);
    }
  }
 
  function setStatus(message) {
    const element = document.getElementById("hlib-dl-status");
    if (element) element.textContent = message;
  }
 
  function setControlsRunning(running) {
    document.querySelectorAll("#hlib-dl-panel button[data-task]").forEach((button) => {
      button.disabled = running;
    });
    const cancel = document.getElementById("hlib-dl-cancel");
    document.querySelectorAll("#hlib-dl-panel input").forEach((input) => {
      input.disabled = running;
    });
    if (cancel) cancel.hidden = !running;
  }
 
  function addPanel() {
    if (document.getElementById("hlib-dl-panel")) return;
    const onArticle = location.pathname.startsWith("/n/");
    const onSeries = location.pathname.startsWith("/s/");
    if (!onArticle && !onSeries) return;
 
    const panel = document.createElement("section");
    panel.id = "hlib-dl-panel";
    panel.innerHTML = `
      <div class="hlib-dl-title">📚 hlib 下载器</div>
      <div class="hlib-dl-settings">
        <label>分页间隔 ≥ 秒
          <input id="hlib-page-delay" type="number" min="2" max="60" step="1" value="${CONFIG.defaultPageDelay}">
        </label>
        <label>章节间隔 ≥ 秒
          <input id="hlib-chapter-delay" type="number" min="3" max="180" step="1" value="${CONFIG.defaultChapterDelay}">
        </label>
      </div>
      <div class="hlib-dl-row">
        ${onArticle ? '<button class="hlib-primary" data-task="article">单章下载</button>' : ""}
        ${onSeries ? '<button class="hlib-primary" data-task="series">系列下载</button>' : ""}
      </div>
      ${onArticle ? '<div class="hlib-dl-row"><button data-task="series">系列下载</button></div>' : ""}
      <div class="hlib-dl-row"><button id="hlib-dl-cancel" class="hlib-danger" hidden>取消</button></div>
      <div id="hlib-dl-status">间隔会随机增加 0%～35%；TXT 保留原文排版。</div>
    `;
 
    panel.addEventListener("click", (event) => {
      const task = event.target.closest("button[data-task]")?.dataset.task;
      if (task) runTask(task);
      if (event.target.id === "hlib-dl-cancel") {
        state.cancelled = true;
        state.loadSerial++;
        setStatus("正在取消……");
      }
    });
    document.body.appendChild(panel);
  }
 
  addPanel();
})();
