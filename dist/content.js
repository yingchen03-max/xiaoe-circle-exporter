(() => {
  // src/content.js
  var BUTTON_CLASS = "xiaoe-circle-export-button";
  var HOST_CLASS = "xiaoe-circle-export-host";
  var STYLE_ID = "xiaoe-circle-export-style";
  var MENU_ID = "xiaoe-circle-export-format-menu";
  var FORMAT_OPTIONS = [
    { format: "md", label: "Markdown \u6587\u6863\uFF08.md\uFF09", hint: "\u4EC5\u6B63\u6587\u4E0E\u8BC4\u8BBA\uFF0C\u5355\u6587\u4EF6\u76F4\u63A5\u4FDD\u5B58" },
    { format: "html", label: "HTML \u79BB\u7EBF\u5305\uFF08.zip\uFF09", hint: "\u542B\u9644\u4EF6\u3001\u56FE\u7247\u3001\u97F3\u9891\u548C\u89C6\u9891" }
  ];
  var scanScheduled = false;
  installStyles();
  scanPage();
  var observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "XIAOE_EXPORT_PROGRESS") return;
    showToast(message.message, message.state);
    const busy = message.state === "working";
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
      button.disabled = busy;
      button.textContent = busy ? "\u6253\u5305\u4E2D\u2026" : "\u6253\u5305\u4E0B\u8F7D";
    }
  });
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanPage();
    });
  }
  function scanPage() {
    if (location.pathname.includes("/feed_detail")) {
      const detailCard = document.querySelector(".feed-item-wrapper, .feed-base-wrapper");
      if (detailCard) attachButton(detailCard, location.href);
      return;
    }
    for (const card of document.querySelectorAll(".feed-base-wrapper")) {
      const detailLink = card.querySelector('a.to-feed-detail[href*="/feed_detail"]');
      if (detailLink) attachButton(card, detailLink.href);
    }
  }
  function attachButton(card, detailUrl) {
    if (card.querySelector(`:scope .${BUTTON_CLASS}`)) return;
    card.classList.add(HOST_CLASS);
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "\u6253\u5305\u4E0B\u8F7D";
    button.title = "\u4E0B\u8F7D\u6B63\u6587\u3001\u9644\u4EF6\u548C\u5B8C\u6574\u8BC4\u8BBA";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showFormatMenu(button, detailUrl);
    });
    card.append(button);
  }
  function onMenuOutsideMouseDown(event) {
    if (!event.target.closest?.(`#${MENU_ID}`)) closeFormatMenu();
  }
  function onMenuKeyDown(event) {
    if (event.key === "Escape") closeFormatMenu();
  }
  function closeFormatMenu() {
    document.getElementById(MENU_ID)?.remove();
    document.removeEventListener("mousedown", onMenuOutsideMouseDown, true);
    document.removeEventListener("keydown", onMenuKeyDown, true);
  }
  function showFormatMenu(button, detailUrl) {
    closeFormatMenu();
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "\u9009\u62E9\u5BFC\u51FA\u683C\u5F0F");
    const rect = button.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    for (const option of FORMAT_OPTIONS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "xiaoe-circle-export-format-option";
      item.setAttribute("role", "menuitem");
      item.dataset.format = option.format;
      const label = document.createElement("span");
      label.className = "xiaoe-circle-export-format-label";
      label.textContent = option.label;
      const hint = document.createElement("span");
      hint.className = "xiaoe-circle-export-format-hint";
      hint.textContent = option.hint;
      item.append(label, hint);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeFormatMenu();
        startExport(button, detailUrl, option.format);
      });
      menu.append(item);
    }
    document.body.append(menu);
    document.addEventListener("mousedown", onMenuOutsideMouseDown, true);
    document.addEventListener("keydown", onMenuKeyDown, true);
  }
  async function startExport(button, detailUrl, format) {
    button.disabled = true;
    button.textContent = "\u6253\u5305\u4E2D\u2026";
    showToast("\u6B63\u5728\u8BFB\u53D6\u5E16\u5B50\u8BE6\u60C5\u2026", "working");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "XIAOE_EXPORT_REQUEST",
        detailUrl,
        format
      });
      if (!response?.ok) throw new Error(response?.error || "\u5BFC\u51FA\u5931\u8D25\u3002");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      button.disabled = false;
      button.textContent = "\u91CD\u65B0\u6253\u5305";
    }
  }
  function showToast(message, state = "working") {
    let toast = document.getElementById("xiaoe-circle-export-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "xiaoe-circle-export-toast";
      document.body.append(toast);
    }
    toast.dataset.state = state;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    if (state !== "working") {
      showToast.timer = setTimeout(() => {
        toast.hidden = true;
      }, 6e3);
    }
  }
  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
    .${HOST_CLASS} {
      position: relative !important;
    }
    .${BUTTON_CLASS} {
      position: absolute;
      z-index: 3;
      top: 16px;
      right: 16px;
      appearance: none;
      padding: 6px 12px;
      border: 1px solid #3478f6;
      border-radius: 999px;
      color: #3478f6;
      background: #fff;
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
      white-space: nowrap;
    }
    .${BUTTON_CLASS}:hover:not(:disabled) { color: #fff; background: #3478f6; }
    .${BUTTON_CLASS}:disabled { cursor: wait; opacity: .6; }
    #${MENU_ID} {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      min-width: 232px;
      padding: 6px;
      border: 1px solid #e3e7ef;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 16px 44px rgb(15 23 42 / 18%);
      font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .xiaoe-circle-export-format-option {
      display: flex;
      flex-direction: column;
      gap: 2px;
      align-items: flex-start;
      width: 100%;
      padding: 8px 10px;
      border: 0;
      border-radius: 8px;
      appearance: none;
      background: none;
      cursor: pointer;
      text-align: left;
    }
    .xiaoe-circle-export-format-option:hover { background: #eef4ff; }
    .xiaoe-circle-export-format-label { color: #1f2b43; font-weight: 600; }
    .xiaoe-circle-export-format-hint { color: #7c8698; font-size: 12px; font-weight: 400; }
    #xiaoe-circle-export-toast {
      position: fixed;
      z-index: 2147483647;
      right: 24px;
      bottom: 24px;
      max-width: 360px;
      padding: 12px 16px;
      border-radius: 10px;
      color: #fff;
      background: #263044;
      box-shadow: 0 12px 38px rgb(0 0 0 / 22%);
      font: 500 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    #xiaoe-circle-export-toast[data-state="done"] { background: #168a5d; }
    #xiaoe-circle-export-toast[data-state="error"] { background: #bf3d3d; }
  `;
    document.head.append(style);
  }
})();
