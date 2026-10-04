(() => {
  "use strict";
  const changes = new WeakMap();
  const running = new WeakMap();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const ease = "cubic-bezier(0.2, 0, 0, 1)";
  function reveal(node) {
    if (!node?.animate || document.hidden || reduced?.matches) return;
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;
    running.get(node)?.cancel();
    const animation = node.animate(
      [
        { opacity: 0.6, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 280, easing: ease },
    );
    running.set(node, animation);
  }
  function update(node, key) {
    if (!node || changes.get(node) === key) return;
    changes.set(node, key);
    reveal(node);
  }
  // Honour a preference change even while a transition is in progress.
  reduced?.addEventListener?.("change", () => {
    if (reduced.matches)
      for (const node of document.querySelectorAll("[data-motion]"))
        running.get(node)?.cancel();
  });
  window.WATER_MOTION = { reveal, update };
})();
