// Packs @multiagency/sdk for a release candidate: the staged package (sdk-stage.ts) with its provenance.
// Output: .test-artifacts/contract/<name>-<version>.tgz with its sha256 and provenance. No publication.
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as contract from "../src/contract/index.js";
import { name, root, run, stage, version } from "./sdk-stage.js";

const out = join(root, ".test-artifacts/contract"), staging = join(out, "package");
const sources = stage(staging, join(out, "tsconfig.json"));

// In a frozen stack snapshot (no Git), its SNAPSHOT.json identifies the exact source tree instead.
const snapshot = existsSync(join(root, "SNAPSHOT.json")) ? JSON.parse(readFileSync(join(root, "SNAPSHOT.json"), "utf8")) as { runDigest: string; sourceHead: string; overlayDiffSha256: string } : null;
const dirty = snapshot ? [] : run("git", ["status", "--porcelain"]).split("\n").filter(Boolean);
writeFileSync(join(staging, "provenance.json"), JSON.stringify({ name, version, wire: { payeeManifestVersion: contract.payeeContract.version, capabilities: contract.payeeContract.capabilities },
  sourceHead: snapshot?.sourceHead ?? run("git", ["rev-parse", "HEAD"]), dirtyPaths: dirty,
  ...(snapshot && { snapshot: { runDigest: snapshot.runDigest, overlayDiffSha256: snapshot.overlayDiffSha256 } }),
  sources: Object.fromEntries(sources.map(file => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")])),
  sourcesDirty: sources.filter(file => dirty.some(line => line.slice(3) === file || line.slice(3).endsWith(`/${file}`) || file.startsWith(line.slice(3)))),
  node: process.version, typescript: run(join(root, "node_modules/.bin/tsc"), ["--version"]), builtAt: new Date().toISOString() }, null, 2) + "\n");

const tarball = run("pnpm", ["pack", "--pack-destination", out], staging).split("\n").at(-1)!;
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${sha256}  ${tarball.split("/").at(-1)}\n`);
cpSync(join(staging, "provenance.json"), join(out, `${name.replace("@", "").replace("/", "-")}-${version}.provenance.json`));
console.log(JSON.stringify({ tarball, sha256 }, null, 2));
