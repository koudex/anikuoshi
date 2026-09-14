/* ══════════════════════════════════════════════════════════════
   AniKuoshi — player.js
   Watch-page engine:
   - Embed-first playback (megaplay iframe, resume via ?time=&unix=)
   - Server switching through server-resolved htmx fragments
   - Progress-watch sync (wall-clock estimate + beacons) → history
   - Auto next / autoplay / auto-skip intro-outro (persisted)
   - Next-episode airing countdown
   - Player keyboard shortcuts
   ══════════════════════════════════════════════════════════════ */
(() => {
  "use strict";
  const { $, $$, store, toast } = window.AK || {};
  if (!$) return;

  const root = $("#watch-root");
  if (!root) return;

  const meta = {
    slug: root.dataset.slug,
    ep: parseInt(root.dataset.ep, 10) || 1,
    title: root.dataset.title,
    poster: root.dataset.poster,
    totalEps: parseInt(root.dataset.totalEps, 10) || 0,
    estDuration: parseInt(root.dataset.estimatedDuration, 10) || 1440,
    nextEp: parseInt(root.dataset.nextEp, 10) || 0,
    prevEp: parseInt(root.dataset.prevEp, 10) || 0,
  };

  const stage = $("#player-stage");
  const embedWrap = $("#player-embed-wrap");
  const skeleton = $("#player-skeleton");
  const fallback = $("#player-fallback");
  const skipIntroBtn = $("#skip-intro");
  const skipOutroBtn = $("#skip-outro");
  let currentEmbedUrl = "";

  // ---------- Toggles (persisted) ----------
  const toggles = {
    autonext: $("#tg-autonext"),
    autoplay: $("#tg-autoplay"),
    autoskip: $("#tg-autoskip"),
  };
  ["autonext", "autoplay", "autoskip"].forEach((key) => {
    const el = toggles[key];
    if (!el) return;
    const saved = store.get(`tg:${key}`, store.get(`pref:${key}`, key !== "autoplay"));
    el.checked = !!saved;
    el.addEventListener("change", () => {
      store.set(`tg:${key}`, el.checked);
      store.set(`pref:${key}`, el.checked);
      toast(`${{ autonext: "Auto next", autoplay: "Autoplay", autoskip: "Auto skip" }[key]}: ${el.checked ? "on" : "off"}`);
    });
  });

  // ---------- Progress sync ----------
  const saved = null; // resume comes from data-resume-* attrs (CSP-safe)
  let position = Math.max(0, parseInt(root.dataset.resumePosition, 10) || 0);
  let watching = false;
  let lastSync = 0;
  let skippedIntro = false;
  let skippedOutro = false;
  let autoNexted = false;

  const ENTRY = {
    slug: meta.slug,
    ep: meta.ep,
    title: meta.title,
    poster: meta.poster,
    epTitle: "",
    position,
    duration: meta.estDuration,
  };

  function saveProgress(force = false) {
    const now = Date.now();
    if (!force && now - lastSync < 10000) return;
    lastSync = now;
    ENTRY.position = Math.round(position);
    ENTRY.duration = Math.round(meta.estDuration);
    const body = new URLSearchParams();
    Object.entries(ENTRY).forEach(([k, v]) => body.append(k, v));
    fetch("/fragments/progress", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      keepalive: true,
    }).catch(() => {});
  }
  const saveBeacon = () => {
    ENTRY.position = Math.round(position);
    const body = new URLSearchParams();
    Object.entries(ENTRY).forEach(([k, v]) => body.append(k, v));
    navigator.sendBeacon?.("/fragments/progress", body);
  };

  // wall-clock watcher — runs only while the tab is visible
  setInterval(() => {
    if (!watching || document.hidden) return;
    position += 1;
    updateSkipUI();
    if (position % 12 === 0) saveProgress();
    checkAutoNext();
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { saveProgress(true); saveBeacon(); }
  });
  window.addEventListener("pagehide", saveBeacon);

  // ---------- Embed loading ----------
  function embedUrlFor(rawUrl, seekTo) {
    try {
      const u = new URL(rawUrl);
      if (/megaplay\.buzz$/i.test(u.hostname) && seekTo > 30) {
        u.searchParams.set("time", String(Math.floor(seekTo)));
        u.searchParams.set("unix", String(Math.floor(Date.now() / 1000)));
      }
      return u.toString();
    } catch { return rawUrl; }
  }

  function loadEmbed(rawUrl, { seek = false, showSkeleton = true } = {}) {
    if (!rawUrl) return;
    currentEmbedUrl = rawUrl;
    if (showSkeleton) skeleton?.classList.remove("is-hidden");
    fallback && (fallback.hidden = true);
    embedWrap.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "player-iframe";
    iframe.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.setAttribute("referrerpolicy", "origin");
    iframe.title = `${meta.title} — episode ${meta.ep} player`;
    iframe.src = embedUrlFor(rawUrl, seek ? position : 0);
    embedWrap.appendChild(iframe);

    iframe.addEventListener("load", () => {
      skeleton?.classList.add("is-hidden");
      watching = true; // start wall-clock estimate
      if (toggles.autoplay?.checked) { /* megaplay autoplays by default */ }
      // kick a first sync so history registers the visit quickly
      saveProgress(true);
    });
    // If the embed refuses to load (network/CSP), surface fallback after 12s
    setTimeout(() => {
      if (!iframe.contentWindow && fallback) {
        skeleton?.classList.add("is-hidden");
        fallback.hidden = false;
      }
    }, 12000);
  }

  // ---------- Stream data application ----------
  const streamNode = $("#stream-data");
  function applyStream(node) {
    if (!node) return;
    const status = node.dataset.status;
    if (status === "error" || !node.dataset.url) {
      skeleton?.classList.add("is-hidden");
      if (fallback) { fallback.hidden = false; fallback.querySelector("p").innerHTML =
        `No playable stream right now <span class="dim">(${node.dataset.error || "unknown"})</span>. Try another server below.`; }
      return;
    }
    loadEmbed(node.dataset.url, { seek: position > 30, showSkeleton: false });
  }
  if (streamNode) applyStream(streamNode);

  // ---------- Server switching ----------
  async function switchServer(linkId, chipEl) {
    $$(".server-chip").forEach(c => c.classList.remove("is-active"));
    if (chipEl) { chipEl.classList.add("is-active"); chipEl.disabled = true; }
    skeleton?.classList.remove("is-hidden");
    try {
      const res = await fetch(`/fragments/stream?slug=${encodeURIComponent(meta.slug)}&ep=${meta.ep}&linkId=${encodeURIComponent(linkId)}`,
        { headers: { "HX-Request": "true" } });
      const html = await res.text();
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const node = tmp.querySelector("#stream-data");
      if (chipEl) chipEl.disabled = false;
      applyStream(node);
      toast(`Server: ${chipEl?.dataset.serverName || "switched"}`, "success");
    } catch {
      if (chipEl) chipEl.disabled = false;
      skeleton?.classList.add("is-hidden");
      toast("Server switch failed", "error");
    }
  }
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".server-chip");
    if (chip && chip.dataset.linkId) switchServer(chip.dataset.linkId, chip);
  });

  // retry buttons
  $("#retry-stream")?.addEventListener("click", () => {
    fallback && (fallback.hidden = true);
    if (currentEmbedUrl) loadEmbed(currentEmbedUrl, { seek: true });
    else applyStream($("#stream-data"));
  });
  $("#retry-servers")?.addEventListener("click", () => location.reload());

  // ---------- Skip intro / outro (skipData + wall-clock estimate) ----------
  const skip = {
    intro: { start: parseFloat(streamNode?.dataset.introStart), end: parseFloat(streamNode?.dataset.introEnd) },
    outro: { start: parseFloat(streamNode?.dataset.outroStart), end: parseFloat(streamNode?.dataset.outroEnd) },
  };
  const has = (r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start;

  function updateSkipUI() {
    const inIntro = has(skip.intro) && position >= skip.intro.start && position < skip.intro.end;
    const inOutro = has(skip.outro) && position >= skip.outro.start && position < skip.outro.end;
    if (skipIntroBtn) skipIntroBtn.hidden = !inIntro;
    if (skipOutroBtn) skipOutroBtn.hidden = !inOutro;
    if (toggles.autoskip?.checked) {
      if (inIntro && !skippedIntro) doSkip("intro");
      if (inOutro && !skippedOutro) doSkip("outro");
    }
  }
  function doSkip(which) {
    const range = skip[which];
    if (!has(range)) return;
    if (which === "intro") skippedIntro = true; else skippedOutro = true;
    position = range.end; // jump our estimate forward
    // For embeds: reload player at the skip point (megaplay honors ?time=)
    if (currentEmbedUrl) loadEmbed(currentEmbedUrl, { seek: true });
    toast(`Skipped ${which}`, "success");
    updateSkipUI();
  }
  skipIntroBtn?.addEventListener("click", () => doSkip("intro"));
  skipOutroBtn?.addEventListener("click", () => doSkip("outro"));

  // ---------- Auto next ----------
  function checkAutoNext() {
    if (!toggles.autonext?.checked || !meta.nextEp || autoNexted) return;
    const outroStart = has(skip.outro) ? skip.outro.start : meta.estDuration * 0.94;
    if (position >= outroStart) {
      autoNexted = true;
      saveProgress(true);
      saveBeacon();
      toast("Auto next → episode " + meta.nextEp, "success", 1800);
      setTimeout(() => { location.href = `/watch/${meta.slug}/${meta.nextEp}`; }, 900);
    }
  }

  // ---------- Next episode countdown ----------
  const countdownEl = $("#next-ep-countdown");
  if (countdownEl && countdownEl.dataset.ts) {
    const target = (parseInt(countdownEl.dataset.ts, 10) || 0) * 1000;
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) { countdownEl.textContent = "Airing now"; return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      countdownEl.textContent = `${d > 0 ? d + "d " : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---------- Episodes drawer ----------
  const drawer = $("#episodes-panel");
  $("#ep-jump")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const n = parseInt(e.target.value, 10);
    if (n >= 1 && (!meta.totalEps || n <= meta.totalEps + 50)) {
      location.href = `/watch/${meta.slug}/${n}`;
    }
  });
  // chip pager buttons (anime-page style nav inside drawer)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ep-page]");
    if (!btn || !drawer) return;
  });

  // ---------- Player keyboard shortcuts ----------
  function playerKeyHandler(e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return true;
    const k = e.key.toLowerCase();
    if (k === "n" && meta.nextEp) { location.href = `/watch/${meta.slug}/${meta.nextEp}`; return false; }
    if (k === "p" && meta.prevEp) { location.href = `/watch/${meta.slug}/${meta.prevEp}`; return false; }
    if (k === "s") { $(".player-col .panel")?.scrollIntoView({ behavior: "smooth", block: "center" }); return false; }
    if (k === "e") {
      drawer?.classList.toggle("is-collapsed");
      if (drawer && drawer.classList.contains("is-collapsed")) drawer.querySelector(".drawer-episodes").style.display = "none";
      else if (drawer) drawer.querySelector(".drawer-episodes").style.display = "";
      return false;
    }
    if (k === "i" && !skipIntroBtn?.hidden) { doSkip("intro"); return false; }
    if (k === "o" && !skipOutroBtn?.hidden) { doSkip("outro"); return false; }
    return true;
  }
  window.AK.playerKeys = playerKeyHandler;
})();
