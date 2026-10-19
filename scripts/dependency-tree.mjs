// A fingerprint of the installed dependency tree: pnpm's installed lockfile and the name of every package directory it
// created (package, version and peer resolution). A copied lockfile alone does not show what is installed.
// Usage: node scripts/dependency-tree.mjs [root]   (prints the fingerprint)
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function dependencyTree(root) {
  const store = join(root, 'node_modules/.pnpm');
  return createHash('sha256').update(readFileSync(join(store, 'lock.yaml'))).update('\0').update(readdirSync(store).sort().join('\n')).digest('hex');
}

if (import.meta.filename === process.argv[1]) console.log(dependencyTree(resolve(process.argv[2] ?? '.')));
