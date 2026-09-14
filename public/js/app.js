/* ══════════════════════════════════════════════════════════════
   AniKuoshi — app.js
   Global client layer: theming, sidebar, search UX, toasts,
   keyboard shortcuts, PWA install + service worker registration.
   NOTE: CSP forbids inline scripts — everything lives here.
   ══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  // ---------- Tiny helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const store = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem(`ak:${key}`); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(`ak:${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
  };
  window.AK = { store, $, $$ }; // shared with page scripts

  // ---------- Toasts ----------
  const toastStack = $("#toast-stack");
  function toast(message, kind = "", ms = 2600) {
    if (!toastStack) return;
    const el = document.createElement("div");
    el.className = `toast ${kind}`.trim();
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 260);
    }, ms);
  }
  window.AK.toast = toast;

  // ---------- Modal ----------
  const modal = $("#global-modal");
  function openModal(title, html) {
    if (!modal) return;
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    modal.hidden = false;
  }
  function closeModal() { if (modal) modal.hidden = true; }
  window.AK.openModal = openModal;

  // ---------- Theme engine ----------
  const THEMES = ["midnight", "carbon", "ocean", "nebula", "sunset", "sakura", "matcha", "paper"];
  const THEME_META = {
    midnight: "Midnight (default dark)", carbon: "Carbon (OLED)", ocean: "Ocean", nebula: "Nebula",
    sunset: "Sunset", sakura: "Sakura (light)", matcha: "Matcha (light)", paper: "Paper (light)",
  };
  function applyTheme(id, announce = true) {
    if (!THEMES.includes(id)) id = "midnight";
    document.documentElement.setAttribute("data-theme", id);
    store.set("theme", id);
    // cookie for server-side no-FOUC rendering
    document.cookie = `ak_theme=${id}; Path=/; SameSite=Lax; Max-Age=${365 * 24 * 3600}`;
    const meta = $('meta[name="theme-color"]');
    if (meta) {
      const light = ["sakura", "matcha", "paper"].includes(id);
      meta.setAttribute("content", light ? "#ffffff" : getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0b0e14");
    }
    if (announce) toast(`Theme: ${THEME_META[id] || id}`);
  }
  function cycleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "midnight";
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    applyTheme(next);
  }
  window.AK.applyTheme = applyTheme;

  // initialize theme-color meta on load (server already set data-theme)
  applyTheme(document.documentElement.getAttribute("data-theme") || "midnight", false);

  // ---------- Sidebar (mobile) ----------
  const sidebar = $("#sidebar");
  const scrim = $("#sidebar-scrim");
  const openBtn = $("#sidebar-open");
  if (openBtn) openBtn.addEventListener("click", () => document.body.classList.add("sidebar-open"));
  if (scrim) scrim.addEventListener("click", () => document.body.classList.remove("sidebar-open"));

  // ---------- Active nav highlighting ----------
  (() => {
    const path = location.pathname;
    let key = "home";
    if (path.startsWith("/browse")) key = "browse";
    else if (path.startsWith("/search")) key = "search";
    else if (path.startsWith("/schedule")) key = "schedule";
    else if (path.startsWith("/az-list")) key = "az";
    else if (path.startsWith("/history")) key = "history";
    else if (path.startsWith("/settings")) key = "settings";
    $$(`[data-nav="${key}"]`).forEach(el => el.classList.add("is-active"));
  })();

  // ---------- Search suggestions UX ----------
  const searchInput = $("#global-search");
  const suggestBox = $("#suggest-box");
  const clearBtn = $("#search-clear");
  if (searchInput && suggestBox) {
    const hide = () => { suggestBox.hidden = true; };
    const maybeShow = () => { if (suggestBox.children.length) suggestBox.hidden = false; };
    searchInput.addEventListener("focus", maybeShow);
    searchInput.addEventListener("input", () => {
      if (clearBtn) clearBtn.hidden = !searchInput.value;
      if (!searchInput.value.trim()) { hide(); suggestBox.innerHTML = ""; }
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hide(); searchInput.blur(); }
      if (e.key === "Enter" && !searchInput.value.trim()) e.preventDefault();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".topbar-search")) hide();
    });
    document.body.addEventListener("htmx:afterSwap", (e) => {
      if (e.target === suggestBox) {
        suggestBox.hidden = !suggestBox.children.length;
      }
    });
    if (clearBtn) clearBtn.addEventListener("click", () => {
      searchInput.value = ""; clearBtn.hidden = true; hide(); searchInput.focus();
    });
  }

  // Quick search FAB (mobile) → focus/scroll to topbar search
  document.addEventListener("click", (e) => {
    const fab = e.target.closest('[data-action="quick-search"]');
    if (fab && searchInput) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => searchInput.focus({ preventScroll: true }), 180);
    }
  });

  // ---------- Image fallbacks (CSP-safe, no inline onerror) ----------
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.hasAttribute("data-fallback-img")) {
      const wrap = img.closest(".card-poster, .suggest-item");
      if (wrap) wrap.classList.add("img-missing");
      img.style.visibility = "hidden";
    }
  }, true);

  // ---------- Relative time ----------

  function relativeTime(ts) {
    const diff = Date.now() - Number(ts);
    if (!Number.isFinite(diff)) return "";
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return `${Math.floor(d / 30)}mo ago`;
  }
  function paintTimes(root = document) {
    $$("[data-relative-time]", root).forEach(el => {
      const t = relativeTime(el.dataset.relativeTime);
      if (el.textContent !== t) el.textContent = t; // guard: avoid re-triggering the observer
    });
  }
  paintTimes();
  let paintQueued = false;
  new MutationObserver(() => {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paintTimes(); });
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- Global delegated actions ----------
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "cycle-theme") cycleTheme();
    if (action === "modal-close") closeModal();
    if (action === "share") {
      const title = el.dataset.shareTitle || "AniKuoshi";
      const url = location.href;
      if (navigator.share) navigator.share({ title, url }).catch(() => {});
      else {
        navigator.clipboard?.writeText(url).then(() => toast("Link copied", "success")).catch(() => toast("Copy failed", "error"));
      }
    }
  });

  // history remove buttons (delegated, htmx swap refreshes list)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-history]");
    if (!btn) return;
    e.preventDefault();
    const slug = btn.dataset.removeHistory;
    const body = new URLSearchParams({ slug });
    fetch("/fragments/history/remove", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
      body,
    })
      .then(r => r.text())
      .then(html => {
        const list = $("#history-list");
        if (list) list.innerHTML = html;
        toast("Removed from history", "success");
      })
      .catch(() => toast("Failed to remove", "error"));
  });

  // ---------- Hero carousel ----------
  (() => {
    const slides = $$(".hero-slide");
    if (slides.length < 2) return;
    let idx = 0, timer = null;
    const dots = $$("[data-hero-dot]");
    const show = (i) => {
      idx = (i + slides.length) % slides.length;
      slides.forEach((s, j) => s.classList.toggle("is-active", j === idx));
      dots.forEach((d, j) => d.classList.toggle("is-active", j === idx));
    };
    const play = () => { timer = setInterval(() => show(idx + 1), 5200); };
    const stop = () => timer && clearInterval(timer);
    dots.forEach(d => d.addEventListener("click", () => { stop(); show(Number(d.dataset.heroDot)); play(); }));
    // swipe support
    let x0 = null;
    const hero = $("#hero-carousel");
    if (hero) {
      hero.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      hero.addEventListener("touchend", (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 44) { stop(); show(idx + (dx < 0 ? 1 : -1)); play(); }
        x0 = null;
      }, { passive: true });
    }
    document.addEventListener("visibilitychange", () => document.hidden ? stop() : play());
    play();
  })();

  // ---------- Keyboard shortcuts (global) ----------
  const SHORTCUTS = [
    ["/", "Focus search"],
    ["N", "Next episode (player)"],
    ["P", "Previous episode (player)"],
    ["S", "Servers panel (player)"],
    ["E", "Episodes panel (player)"],
    ["I", "Skip intro (player)"],
    ["O", "Skip outro (player)"],
    ["T", "Cycle theme"],
    ["?", "Shortcut help"],
    ["Esc", "Close dialogs"],
  ];
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (e.key === "Escape") { closeModal(); document.body.classList.remove("sidebar-open"); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      if (searchInput) { window.scrollTo({ top: 0, behavior: "smooth" }); searchInput.focus({ preventScroll: true }); }
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      openModal("Keyboard shortcuts", SHORTCUTS.map(([k, d]) =>
        `<div class="shortcut-row"><span>${d}</span><kbd>${k}</kbd></div>`).join(""));
      return;
    }
    if (e.key.toLowerCase() === "t") { cycleTheme(); }
    // Player-scoped keys are handled in player.js (only when present)
    if (window.AK.playerKeys && !window.AK.playerKeys(e)) return;
  });

  // ---------- htmx niceties ----------
  document.body.addEventListener("htmx:afterSwap", (e) => {
    // animate swapped content
    if (e.detail && e.detail.target) {
      e.detail.target.querySelectorAll?.(".card, .ep-chip, .schedule-item").forEach(el => {
        el.style.animation = "fade-up .35s ease both";
      });
    }
  });
  document.body.addEventListener("htmx:responseError", () => toast("Network hiccup — try again", "error"));
  document.body.addEventListener("htmx:sendError", () => toast("You appear to be offline", "error"));

  // ---------- PWA: service worker + install ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = $("#pwa-install");
    if (installBtn) installBtn.hidden = false;
  });
  document.addEventListener("click", async (e) => {
    if (e.target.closest("#pwa-install") && deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
      toast(outcome === "accepted" ? "Installing…" : "Install dismissed");
      deferredPrompt = null;
    }
  });
})();
