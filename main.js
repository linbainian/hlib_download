// ==UserScript==
// @name         hlib图书馆下载
// @namespace    http://tampermonkey.net/
// @version      1.1
// @license      MIT
// @description  自动下载小说网站的所有章节内容
// @author       liepainian
// @match        https://hlib.cc/n/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      hlib.cc
// @downloadURL https://update.greasyfork.org/scripts/532804/hlib%E5%9B%BE%E4%B9%A6%E9%A6%86%E4%B8%8B%E8%BD%BD.user.js
// @updateURL https://update.greasyfork.org/scripts/532804/hlib%E5%9B%BE%E4%B9%A6%E9%A6%86%E4%B8%8B%E8%BD%BD.meta.js
// ==/UserScript==

(function () {
  "use strict";

  // 添加下载按钮
  function addDownloadButton() {
    const btn = document.createElement("button");
    btn.id = "tm-download";
    btn.className = "btn btn-primary";
    btn.innerHTML = "📚 一键下载全集";
    btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            padding: 12px 24px;
            font-size: 16px;
        `;
    btn.onclick = startDownload;

    document.body.appendChild(btn);
  }

  // 获取当前章节信息
  function getChapterInfo() {
    try {
      const seriesLinks = [...document.querySelectorAll("#s-pages a")].map((a) => new URL(a.href).pathname);
      const currentChapter = {
        title: document.title.replace(/- \d+$/, "").trim(),
        author: document.querySelector('.list-group-item a[href^="/u/"] span')?.textContent?.trim() || "未知作者",
        series: [...new Set(seriesLinks)],
        currentUrl: window.location.pathname,
      };

      if (!currentChapter.series.includes(currentChapter.currentUrl)) {
        currentChapter.series.unshift(currentChapter.currentUrl);
      }

      return currentChapter;
    } catch (error) {
      console.error("解析章节信息失败:", error);
      return null;
    }
  }

  // 获取单页内容（修改核心）
  async function fetchPageContent(url, page = 1) {
    const pageUrl = page > 1 ? `${url}?p=${page}` : url;
    let retryCount = 0;

    while (retryCount < 3) {
      try {
        const { content, totalPages } = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "GET",
            url: `https://hlib.cc${pageUrl}`,
            onload: function (response) {
              const parser = new DOMParser();
              const doc = parser.parseFromString(response.responseText, "text/html");

              // 改进的分页判断逻辑
              const pageSelect = doc.querySelector("select.form-select");
              const urlParams = new URLSearchParams(response.finalUrl.split("?")[1]);
              const currentPage = urlParams.get("p") || 1;

              let totalPages = pageSelect ? Math.max(...[...pageSelect.options].map((o) => parseInt(o.value))) : parseInt(currentPage);

              // 增强内容选择器
              const contentElement = doc.getElementById("content") || doc.querySelector(".article-content") || doc.querySelector("pre");
              const content = contentElement?.innerText || "内容解析失败，请检查选择器";

              resolve({ content, totalPages });
            },
            onerror: () => resolve({ content: "请求失败，请检查网络", totalPages: 1 }),
          });
        });

        // 内容有效性检查
        if (!content.includes("失败") && content.length > 100) {
          return { content, totalPages };
        }

        retryCount++;
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        retryCount++;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return { content: "内容获取失败（超过重试次数）", totalPages: 1 };
  }

  // 下载整个章节（新增重试机制）
  async function downloadChapter(url) {
    let fullContent = "";
    let currentPage = 1;
    let totalPages = 1;

    do {
      const { content, totalPages: tp } = await fetchPageContent(url, currentPage);
      fullContent += `\n第 ${currentPage} 页\n${content}\n\n`;
      totalPages = tp;

      const btn = document.getElementById("tm-download");
      if (btn) {
        btn.innerHTML = `📥 下载中 (${currentPage}/${totalPages})`;
      }

      currentPage++;
      await new Promise((r) => setTimeout(r, 2500));
    } while (currentPage <= totalPages && !fullContent.includes("失败"));

    return fullContent;
  }

  // 主下载流程
  async function startDownload() {
    try {
      const info = getChapterInfo();
      if (!info) {
        alert("无法解析页面信息，请确认在正确的小说页面");
        return;
      }

      let fullText = `${info.title}\n作者：${info.author}\n\n`;

      for (const [index, chapterUrl] of info.series.entries()) {
        const chapterContent = await downloadChapter(chapterUrl);
        fullText += `\n\n第 ${index + 1} 章\n${chapterContent}`;
      }

      const blob = new Blob([fullText], { type: "text/plain;charset=utf-8" });
      const filename = `${info.title} - ${info.author}.txt`;

      GM_download({
        url: URL.createObjectURL(blob),
        name: filename,
        saveAs: true,
      });

      const btn = document.getElementById("tm-download");
      if (btn) {
        btn.innerHTML = "✅ 下载完成";
        setTimeout(() => btn.remove(), 3000);
      }
    } catch (error) {
      console.error("下载失败:", error);
      const btn = document.getElementById("tm-download");
      if (btn) btn.innerHTML = "❌ 下载失败";
    }
  }

  // 启动脚本
  addDownloadButton();
})();
