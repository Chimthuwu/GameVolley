#!/usr/bin/env node
// build-shared.mjs — Build shared UI code for both renderer (Electron) and web (Cloudflare Pages)
// Reads from src/shared/, src/renderer/, src/web/ and emits to renderer/ and site/

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const SHARED_DIR = path.join(ROOT, 'src', 'shared');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const WEB_DIR = path.join(ROOT, 'src', 'web');
const OUT_RENDERER = path.join(ROOT, 'renderer');
const OUT_WEB = path.join(ROOT, 'site');

function readDir(dir) {
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir);
  const result = {};
  for (const file of files) {
    const full = path.join(dir, file);
    if (fs.statSync(full).isFile()) {
      result[file] = fs.readFileSync(full, 'utf8');
    }
  }
  return result;
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ✓ ${path.relative(ROOT, destPath)}`);
    }
  }
}

function writeFile(dir, file, content) {
  const full = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  console.log(`  ✓ ${path.relative(ROOT, full)}`);
}

// Process a file with conditional blocks: // @platform:renderer or // @platform:web
// Lines between // @if:renderer and // @endif are only included for renderer
// Lines between // @if:web and // @endif are only included for web
function processConditionals(content, platform) {
  const lines = content.split('\n');
  const out = [];
  let inBlock = true;
  let blockPlatform = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('// @if:')) {
      blockPlatform = trimmed.slice(7).trim();
      inBlock = (blockPlatform === platform);
      continue;
    }
    if (trimmed === '// @endif') {
      inBlock = true;
      blockPlatform = null;
      continue;
    }
    if (trimmed.startsWith('// @platform:')) {
      // Single-line platform directive: // @platform:renderer console.log('electron only');
      const p = trimmed.slice(13).trim();
      if (p === platform) {
        out.push(line.slice(line.indexOf('// @platform:') + 13 + p.length).trimStart());
      }
      continue;
    }

    if (inBlock) {
      out.push(line);
    }
  }

  return out.join('\n');
}

function build() {
  console.log('Building shared UI code...');

  // Read shared files
  const shared = readDir(SHARED_DIR);
  const rendererSpecific = readDir(RENDERER_DIR);
  const webSpecific = readDir(WEB_DIR);

  // Build renderer/app.js
  const rendererParts = [];
  if (shared['app-core.js']) rendererParts.push(processConditionals(shared['app-core.js'], 'renderer'));
  if (rendererSpecific['app.js']) rendererParts.push(processConditionals(rendererSpecific['app.js'], 'renderer'));
  writeFile(OUT_RENDERER, 'app.js', rendererParts.join('\n\n'));

  // Build site/app.js
  const webParts = [];
  if (shared['app-core.js']) webParts.push(processConditionals(shared['app-core.js'], 'web'));
  if (webSpecific['app.js']) webParts.push(processConditionals(webSpecific['app.js'], 'web'));
  writeFile(OUT_WEB, 'app.js', webParts.join('\n\n'));

  // Build styles: shared + platform-specific
  const rendererStyles = [];
  if (shared['style.css']) rendererStyles.push(processConditionals(shared['style.css'], 'renderer'));
  if (rendererSpecific['style.css']) rendererStyles.push(processConditionals(rendererSpecific['style.css'], 'renderer'));
  writeFile(OUT_RENDERER, 'style.css', rendererStyles.join('\n\n'));

  const webStyles = [];
  if (shared['style.css']) webStyles.push(processConditionals(shared['style.css'], 'web'));
  if (webSpecific['style.css']) webStyles.push(processConditionals(webSpecific['style.css'], 'web'));
  writeFile(OUT_WEB, 'style.css', webStyles.join('\n\n'));

  // Copy shared assets that don't need processing
  for (const [file, content] of Object.entries(shared)) {
    if (!['app-core.js', 'style.css'].includes(file)) {
      writeFile(OUT_RENDERER, file, content);
      writeFile(OUT_WEB, file, content);
    }
  }

  // Copy platform-specific assets (non-processed)
  for (const [file, content] of Object.entries(rendererSpecific)) {
    if (!['app.js', 'style.css'].includes(file)) {
      writeFile(OUT_RENDERER, file, content);
    }
  }
  for (const [file, content] of Object.entries(webSpecific)) {
    if (!['app.js', 'style.css'].includes(file)) {
      writeFile(OUT_WEB, file, content);
    }
  }

  // Copy static assets directories
  copyDirRecursive(path.join(RENDERER_DIR, 'assets'), path.join(OUT_RENDERER, 'assets'));
  copyDirRecursive(path.join(WEB_DIR, 'assets'), path.join(OUT_WEB, 'assets'));
  copyDirRecursive(path.join(WEB_DIR, 'about'), path.join(OUT_WEB, 'about'));

  console.log('Build complete.');
}

build();