// Prints every package <source file> requires that cannot be loaded from <app dir>.
// Used by deploy-live.sh when package-lock.json differs from live but package.json does not.
// Usage: node ops/check-modules.js <source file> <app dir>     (empty output = all present)
const fs = require('fs');
const { builtinModules } = require('module');

const [file, appDir] = process.argv.slice(2);
if (!file || !appDir) { console.error('usage: check-modules.js <source file> <app dir>'); process.exit(2); }

const src = fs.readFileSync(file, 'utf8');
const builtin = new Set(builtinModules);
const used = [...new Set([...src.matchAll(/require\(['"]([^'"./][^'"]*)['"]\)/g)].map(m => m[1]))]
  .filter(m => !builtin.has(m.replace(/^node:/, '')));

const missing = used.filter(m => {
  try { require.resolve(m, { paths: [appDir] }); return false; } catch (_) { return true; }
});
console.log(missing.join(' '));
