/* AniKuoshi — page-anime.js — episode pager counter on the details page */
(() => {
  "use strict";
  const { $ } = window.AK || {};
  if (!$) return;

  document.body.addEventListener("htmx:afterSwap", (e) => {
    if (e.target?.id !== "episodes-chunks") return;
    const meta = e.detail?.xmlHttpRequest?.responseText?.match(/id="ep-pages" data-page="(\d+)" data-total-pages="(\d+)"/);
    if (meta) {
      const current = $("#ep-page-current");
      if (current) current.textContent = meta[1];
    }
  });
})();
