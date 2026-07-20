#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const sourceRoot = join(root, 'src');
const supportedExtensions = new Set(['.ts', '.js', '.vue']);
const ignoredDirectories = new Set(['node_modules', 'dist', 'coverage']);
const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolutePath));
    else if (entry.isFile() && supportedExtensions.has(extname(entry.name))) files.push(absolutePath);
  }
  return files;
}

function layerOf(relativePath) {
  const [, layer = '(root)'] = relativePath.split('/');
  return layer;
}

function countImports(source) {
  const imports = [];
  for (const match of source.matchAll(importPattern)) imports.push(match[1]);
  return imports;
}

if (!statSync(sourceRoot).isDirectory()) throw new Error('src directory not found');

const files = walk(sourceRoot).map(absolutePath => {
  const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
  const source = readFileSync(absolutePath, 'utf8');
  const lines = source.split(/\r?\n/).length;
  const imports = countImports(source);
  return { relativePath, layer: layerOf(relativePath), lines, imports };
});

const layerSummary = new Map();
for (const file of files) {
  const current = layerSummary.get(file.layer) ?? { files: 0, lines: 0 };
  current.files += 1;
  current.lines += file.lines;
  layerSummary.set(file.layer, current);
}

const topFiles = [...files].sort((a, b) => b.lines - a.lines).slice(0, 25);
const highFanOut = [...files].sort((a, b) => b.imports.length - a.imports.length).slice(0, 15);
const totalLines = files.reduce((sum, file) => sum + file.lines, 0);

console.log('# Codebase inventory');
console.log('');
console.log(`- Source files: ${files.length}`);
console.log(`- Source lines: ${totalLines}`);
console.log('');
console.log('## Layers');
console.log('');
console.log('| Directory | Files | Lines |');
console.log('| --- | ---: | ---: |');
for (const [layer, summary] of [...layerSummary].sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(`| src/${layer} | ${summary.files} | ${summary.lines} |`);
}
console.log('');
console.log('## Largest source files');
console.log('');
console.log('| File | Lines | Imports |');
console.log('| --- | ---: | ---: |');
for (const file of topFiles) console.log(`| ${file.relativePath} | ${file.lines} | ${file.imports.length} |`);
console.log('');
console.log('## Highest import fan-out');
console.log('');
console.log('| File | Imports | Lines |');
console.log('| --- | ---: | ---: |');
for (const file of highFanOut) console.log(`| ${file.relativePath} | ${file.imports.length} | ${file.lines} |`);
