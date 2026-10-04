import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const script = readFileSync(
  new URL("../assets/motion.js", import.meta.url),
  "utf8",
);
function harness() {
  const preference = {
    matches: false,
    addEventListener: (_, cb) => {
      preference.change = cb;
    },
  };
  const calls = [];
  const node = {
    textContent: "2.06",
    rect: { top: 10, bottom: 60 },
    getBoundingClientRect() {
      return this.rect;
    },
    animate(frames, options) {
      const animation = {
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      calls.push({ frames, options, animation });
      return animation;
    },
  };
  const context = {
    window: { innerHeight: 844, matchMedia: () => preference },
    document: { hidden: false, querySelectorAll: () => [node] },
  };
  vm.runInNewContext(script, context);
  return {
    node,
    calls,
    preference,
    context,
    motion: context.window.WATER_MOTION,
  };
}
test("a repeated reading does not replay motion or invent intermediate numbers", () => {
  const h = harness();
  h.motion.update(h.node, "rid:383:0/2.06");
  h.motion.update(h.node, "rid:383:0/2.06");
  assert.equal(h.calls.length, 1);
  assert.equal(h.node.textContent, "2.06");
  h.motion.update(h.node, "rid:383:0/2.05");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].animation.cancelled, true);
  assert.equal(h.calls[1].options.duration, 280);
});
test("reduced motion, hidden pages and offscreen readings suppress movement", () => {
  const h = harness();
  h.preference.matches = true;
  h.motion.reveal(h.node);
  h.preference.matches = false;
  h.context.document.hidden = true;
  h.motion.reveal(h.node);
  h.context.document.hidden = false;
  h.node.rect = { top: 1000, bottom: 1050 };
  h.motion.reveal(h.node);
  assert.equal(h.calls.length, 0);
  h.node.rect = { top: 10, bottom: 60 };
  h.motion.reveal(h.node);
  h.preference.matches = true;
  h.preference.change();
  assert.equal(h.calls[0].animation.cancelled, true);
});
