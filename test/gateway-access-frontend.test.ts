import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFrontend } from "../src/gateway/access-frontend.js";

test("shared consent uses Proto while independent product pages and assets stay local", () => {
  const exists = (file: string) => file === "/treasury/static/existing.js";
  assert.equal(accessFrontend("/treasury", "/proto", "/a/portfolio/access", exists), "/proto");
  assert.equal(accessFrontend("/treasury", "/proto", "/a/portfolio/access/", exists), "/proto");
  assert.equal(accessFrontend("/treasury", "/proto", "/a/portfolio/", exists), "/treasury");
  assert.equal(accessFrontend("/treasury", "/proto", "/static/existing.js", exists), "/treasury");
  assert.equal(accessFrontend("/treasury", "/proto", "/static/shared-hash.js", exists), "/proto");
  assert.equal(accessFrontend("/treasury", "/proto", "/other.json", exists), "/treasury");
  assert.equal(accessFrontend(undefined, "/proto", "/", exists), "/proto");
});
