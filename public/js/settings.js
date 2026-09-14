/* AniKuoshi — settings.js */
(() => {
  "use strict";
  const { $, $$, store, toast, applyTheme } = window.AK || {};
  if (!$) return;

  // Theme picker
  $$(".theme-card").forEach((card) => {
    card.addEventListener("click", () => {
      const id = card.dataset.setTheme;
      applyTheme(id, false);
      $$(".theme-card").forEach(c => {
        const active = c === card;
        c.classList.toggle("is-active", active);
        c.setAttribute("aria-checked", String(active));
      });
      toast(`Theme: ${card.querySelector(".theme-name")?.textContent || id}`, "success");
    });
  });

  // Playback defaults (mirror player toggles)
  ["autonext", "autoplay", "autoskip"].forEach((key) => {
    const el = $(`#st-${key}`);
    if (!el) return;
    el.checked = !!store.get(`pref:${key}`, key !== "autoplay");
    el.addEventListener("change", () => {
      store.set(`pref:${key}`, el.checked);
      store.set(`tg:${key}`, el.checked);
      toast("Playback defaults saved", "success", 1600);
    });
  });
})();
