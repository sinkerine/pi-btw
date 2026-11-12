import { expect, test } from "vitest";
import { digest } from "../../src/digest.js";

test("digest preserves insertion order and detects changed prefix bytes", () => {
  expect(digest({ a: 1, b: 2 })).toBe(digest({ a: 1, b: 2 }));
  expect(digest({ a: 1, b: 2 })).not.toBe(digest({ b: 2, a: 1 }));
  expect(digest([{ text: "雪" }])).not.toBe(digest([{ text: "雪 " }]));
  expect(digest([])).toMatch(/^[a-f0-9]{64}$/);
});
