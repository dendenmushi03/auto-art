/* public/ad-edit.js  (案A: /api/ad/me + /api/ad/submit) */
(() => {
  const LIMITS = {
    TITLE_MAX: 60,
    BODY_MAX: 200,
  };

  const API = {
    GET_ME: (token) => `/api/ad/me?token=${encodeURIComponent(token)}`,
    SUBMIT: `/api/ad/submit`,
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    badge: $("statusBadge"),
    rangeText: $("rangeText"),
    remainText: $("remainText"),

    form: $("adForm"),
    saveBtn: $("saveBtn"),
    resetBtn: $("resetBtn"),
    msg: $("formMsg"),

    title: $("titleInput"),
    url: $("urlInput"),
    body: $("bodyInput"),
    bodyCount: $("bodyCount"),

    titleErr: $("titleErr"),
    urlErr: $("urlErr"),
    bodyErr: $("bodyErr"),

    pvTitle: $("pvTitle"),
    pvBody: $("pvBody"),
    pvLink: $("pvLink"),
  };

  let token = null;
  let initial = { title: "", linkUrl: "", body: "" };
  let slot = null; // {status, startsAt, endsAt, ad, ...}
  let timer = null;

  function getTokenFromQuery() {
    const q = new URLSearchParams(location.search);
    return q.get("token") || q.get("t") || "";
  }

  function setBadge(kind, text) {
    els.badge.className = `badge ${kind}`;
    els.badge.textContent = text;
  }

  function fmtDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtRemain(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h <= 0) return `あと ${m}分 ${String(ss).padStart(2, "0")}秒`;
    return `あと ${h}時間 ${m}分`;
  }

  function isHttpsUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function showFieldError(elErr, message) {
    elErr.hidden = !message;
    elErr.textContent = message || "";
  }

  function setFormMessage(type, text) {
    els.msg.hidden = false;
    els.msg.className = `form-msg form-msg--${type}`;
    els.msg.textContent = text;
  }

  function clearFormMessage() {
    els.msg.hidden = true;
    els.msg.textContent = "";
  }

  function updatePreview() {
    const t = els.title.value.trim();
    const u = els.url.value.trim();
    const b = els.body.value.trim();

    els.pvTitle.textContent = t || "（タイトル）";

    if (b) {
      els.pvBody.hidden = false;
      els.pvBody.textContent = b;
    } else {
      els.pvBody.hidden = true;
      els.pvBody.textContent = "";
    }

    if (isHttpsUrl(u)) {
      els.pvLink.href = u;
      els.pvLink.classList.remove("is-disabled");
      els.pvLink.setAttribute("aria-disabled", "false");
    } else {
      els.pvLink.href = "#";
      els.pvLink.classList.add("is-disabled");
      els.pvLink.setAttribute("aria-disabled", "true");
    }

    els.bodyCount.textContent = `${els.body.value.length}/${LIMITS.BODY_MAX}`;
  }

  function applyInitialToForm() {
    els.title.value = initial.title || "";
    els.url.value = initial.linkUrl || "";
    els.body.value = initial.body || "";
    updatePreview();
  }

  function validate() {
    clearFormMessage();
    let ok = true;

    const title = els.title.value.trim();
    const linkUrl = els.url.value.trim();
    const body = els.body.value.trim();

    // タイトル: 必須 + 60文字以内
    if (!title) {
      ok = false;
      showFieldError(els.titleErr, "タイトルは必須です。");
    } else if (title.length > LIMITS.TITLE_MAX) {
      ok = false;
      showFieldError(els.titleErr, `タイトルは${LIMITS.TITLE_MAX}文字以内で入力してください。`);
    } else {
      showFieldError(els.titleErr, "");
    }

    // リンクURL: 必須 + httpsのみ
    if (!linkUrl) {
      ok = false;
      showFieldError(els.urlErr, "リンクURLは必須です。");
    } else if (!isHttpsUrl(linkUrl)) {
      ok = false;
      showFieldError(els.urlErr, "https:// から始まるURLのみ利用できます。");
    } else {
      showFieldError(els.urlErr, "");
    }

    // 本文: 任意 + 200文字以内
    if (body.length > LIMITS.BODY_MAX) {
      ok = false;
      showFieldError(els.bodyErr, `本文は${LIMITS.BODY_MAX}文字以内で入力してください。`);
    } else {
      showFieldError(els.bodyErr, "");
    }

    return ok;
  }

  function setEditable(enabled) {
    els.title.disabled = !enabled;
    els.url.disabled = !enabled;
    els.body.disabled = !enabled;
    els.saveBtn.disabled = !enabled;
    els.resetBtn.disabled = !enabled;
  }

  function updateTimeUI() {
    if (!slot) return;

    const startsAt = slot.startsAt ? new Date(slot.startsAt) : null;
    const endsAt = slot.endsAt ? new Date(slot.endsAt) : null;

    if (startsAt && endsAt) {
      els.rangeText.textContent = `${fmtDate(startsAt)} 〜 ${fmtDate(endsAt)}`;
      const remain = endsAt.getTime() - Date.now();
      els.remainText.textContent = fmtRemain(remain);
    } else {
      els.rangeText.textContent = "未割当（次作品の生成後に有効化されます）";
      els.remainText.textContent = "—";
    }

    if (slot.status === "active") {
      setBadge("badge--ok", "有効");
      setEditable(true);
    } else if (slot.status === "pending") {
      setBadge("badge--muted", "未割当");
      // 先に入力して保存しておけるのが体験良い
      setEditable(true);
    } else {
      setBadge("badge--ng", "期限切れ");
      setEditable(false);
      setFormMessage("warn", "この広告枠は期限切れです。編集はできません。");
    }
  }

  async function fetchMe() {
    const res = await fetch(API.GET_ME(token), { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `GET /api/ad/me failed (${res.status})`);
    }
    return data; // {status, startsAt, endsAt, ad, ...}
  }

  async function submitAd() {
    const payload = {
      token,
      title: els.title.value.trim(),
      linkUrl: els.url.value.trim(),
      body: els.body.value.trim(),
    };

    const res = await fetch(API.SUBMIT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `POST /api/ad/submit failed (${res.status})`);
    }
    return data;
  }

  function bindEvents() {
    els.title.addEventListener("input", updatePreview);
    els.url.addEventListener("input", updatePreview);
    els.body.addEventListener("input", updatePreview);

    els.resetBtn.addEventListener("click", () => {
      applyInitialToForm();
      clearFormMessage();
      showFieldError(els.titleErr, "");
      showFieldError(els.urlErr, "");
      showFieldError(els.bodyErr, "");
    });

    els.form.addEventListener("submit", async (e) => {
      e.preventDefault();

      if (!slot) return;

      if (slot.status === "expired") {
        setFormMessage("warn", "期限切れのため保存できません。");
        return;
      }

      if (!validate()) {
        setFormMessage("error", "入力内容を確認してください。");
        return;
      }

      try {
        els.saveBtn.disabled = true;
        setFormMessage("info", "保存中…");

        await submitAd();

        // UI側の初期値も更新（戻す用）
        initial = {
          title: els.title.value.trim(),
          linkUrl: els.url.value.trim(),
          body: els.body.value.trim(),
        };

        setFormMessage("ok", "保存しました。");
      } catch (err) {
        console.error(err);
        setFormMessage("error", `保存に失敗しました：${err.message}`);
      } finally {
        els.saveBtn.disabled = false;
      }
    });
  }

  async function init() {
    token = getTokenFromQuery();
    if (!token) {
      setBadge("badge--ng", "トークンなし");
      setEditable(false);
      setFormMessage("error", "URLに token がありません（例：/ad-edit.html?token=xxxx）。");
      return;
    }

    bindEvents();
    setBadge("badge--muted", "読み込み中");
    setEditable(false);

    try {
      slot = await fetchMe();

      initial = {
        title: slot.ad?.title || "",
        linkUrl: slot.ad?.linkUrl || "",
        body: slot.ad?.body || "",
      };

      applyInitialToForm();
      updateTimeUI();

      // 残り時間は30秒おきに更新（軽量）
      timer = setInterval(updateTimeUI, 30000);
    } catch (err) {
      console.error(err);
      setBadge("badge--ng", "取得失敗");
      setFormMessage("error", `広告枠の取得に失敗しました：${err.message}`);
    }
  }

  window.addEventListener("beforeunload", () => timer && clearInterval(timer));
  init();
})();
