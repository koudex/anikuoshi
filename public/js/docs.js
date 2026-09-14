/* AniKuoshi — docs.js — the API playground executor */
(() => {
  "use strict";
  const { $, $$ } = window.AK || {};
  if (!$) return;

  function syntaxHighlight(json) {
    const esc = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = "j-num";
        if (/^"/.test(match)) cls = /:$/.test(match) ? "j-key" : "j-str";
        else if (/true|false/.test(match)) cls = "j-bool";
        else if (/null/.test(match)) cls = "j-null";
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  function buildUrl(card) {
    let path = card.dataset.path;
    const params = new URLSearchParams();
    $$(".ep-param input", card).forEach((input) => {
      const key = input.dataset.param;
      const value = input.value.trim();
      if (!value) return;
      if (key.startsWith(":")) {
        path = path.replace(key, encodeURIComponent(value));
      } else {
        params.append(key, value);
      }
    });
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  }

  $$("[data-endpoint]").forEach((card) => {
    const statusEl = $(".ep-status", card);
    const result = $(".ep-result", card);
    const metaEl = $(".ep-result-meta", card);
    const jsonEl = $(".ep-json", card);

    $("[data-execute]", card)?.addEventListener("click", async () => {
      const url = buildUrl(card);
      statusEl.textContent = "Executing…";
      result.hidden = true;
      const t0 = performance.now();
      try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const text = await res.text();
        const ms = Math.round(performance.now() - t0);
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
        statusEl.textContent = `${res.status} ${res.statusText || ""} · ${ms}ms`;
        metaEl.textContent = `GET ${url} → ${res.status} (${ms}ms, ${(text.length / 1024).toFixed(1)} KB)`;
        jsonEl.innerHTML = syntaxHighlight(pretty);
        result.hidden = false;
      } catch (err) {
        const ms = Math.round(performance.now() - t0);
        statusEl.textContent = `Failed · ${ms}ms`;
        metaEl.textContent = `GET ${url}`;
        jsonEl.textContent = String(err);
        result.hidden = false;
      }
    });

    $("[data-copy-path]", card)?.addEventListener("click", async () => {
      const url = location.origin + buildUrl(card);
      try {
        await navigator.clipboard.writeText(url);
        statusEl.textContent = "Path copied ✓";
      } catch {
        statusEl.textContent = "Copy failed";
      }
    });
  });
})();
