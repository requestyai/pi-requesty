import assert from "node:assert/strict";
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercise pi's actual loader outside the checkout: git-installed extensions
// cannot rely on a local node_modules directory or arbitrary pi-ai subpaths.
const { loadExtensions } = await import(new URL(
  "./core/extensions/loader.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
));

test("git-installed extension loads through pi without local dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-requesty-loader-"));
  try {
    for (const file of ["requesty.js", "models.js", "endpoint.js"]) {
      await copyFile(new URL(`../${file}`, import.meta.url), join(directory, file));
    }
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const result = await loadExtensions([join(directory, "requesty.js")], directory);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has("requesty-refresh"));
    assert.equal(result.runtime.pendingNativeProviderRegistrations[0].provider.id, "requesty");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
