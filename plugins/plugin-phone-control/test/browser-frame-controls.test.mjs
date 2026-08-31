import assert from "node:assert/strict";
import { containedImageRect, mapPointerToViewport } from "../public/lib/browser-frame-controls.js";

export const tests = [
  {
    name: "maps a scaled browser screenshot back to viewport coordinates",
    run() {
      assert.deepEqual(mapPointerToViewport({
        clientX: 170,
        clientY: 120,
        elementRect: { left: 10, top: 20, width: 320, height: 200 },
        intrinsicWidth: 1280,
        intrinsicHeight: 800,
        viewportWidth: 1280,
        viewportHeight: 800,
      }), { x: 640, y: 400 });
    },
  },
  {
    name: "rejects browser taps inside object-fit letterbox bars",
    run() {
      assert.deepEqual(containedImageRect({ left: 0, top: 0, width: 300, height: 300 }, 400, 200), {
        left: 0,
        top: 75,
        width: 300,
        height: 150,
      });
      assert.equal(mapPointerToViewport({
        clientX: 150,
        clientY: 30,
        elementRect: { left: 0, top: 0, width: 300, height: 300 },
        intrinsicWidth: 400,
        intrinsicHeight: 200,
        viewportWidth: 800,
        viewportHeight: 400,
      }), null);
    },
  },
];
