#!/usr/bin/env node
'use strict';

// Documentation punctuation check (docs.yml).
//
// Scans .md/.mdx/.txt files for prose punctuation violations:
//   - HARD FAIL: the Unicode em dash (U+2014) used as prose punctuation.
//   - WARNING-ONLY: prose "--" used as a dash substitute (word--word, word -- word).
//
// Technical syntax is preserved and never flagged:
//   - fenced code blocks and inline code spans (backtick content)
//   - Markdown horizontal rules (---)
//   - Markdown table separator rows (|---|---|)
//   - CLI flags (--network), POSIX "--" separators
//
// Exit code 1 only when em dashes are found in prose.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'typedoc']);
const EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const EM_DASH = '\u2014';

function collectFiles(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) collectFiles(full, acc);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

function isHorizontalRule(raw) {
  return /^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(raw);
}

function isTableSeparator(raw) {
  const line = raw.trim();
  if (!line.startsWith('|') || !line.endsWith('|')) return false;
  return /^\|[\s|:|-]*\|$/.test(line) && line.includes('-');
}

function scanFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const emDashes = [];
  const proseDashes = [];
  let inFence = false;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (/^\s*(```+|~~~+)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (isHorizontalRule(raw)) return;
    if (isTableSeparator(raw)) return;

    const prose = raw.replace(/`[^`]*`/g, '');

    const emIdx = prose.indexOf(EM_DASH);
    if (emIdx !== -1) {
      emDashes.push({ lineNo, col: emIdx + 1, text: trimmed });
    }

    const adjacent = prose.match(/[A-Za-z0-9]--[A-Za-z0-9]/);
    const spaced = prose.match(/\S -- \S/);
    if (adjacent || spaced) {
      proseDashes.push({
        lineNo,
        text: trimmed,
        pattern: adjacent ? 'word--word' : 'word -- word',
      });
    }
  });

  return { emDashes, proseDashes };
}

function rel(p) {
  return path.relative(ROOT, p);
}

function main() {
  const files = collectFiles(ROOT, []);
  let emTotal = 0;
  let dashTotal = 0;

  for (const file of files) {
    const { emDashes, proseDashes } = scanFile(file);
    emTotal += emDashes.length;
    dashTotal += proseDashes.length;

    for (const hit of emDashes) {
      console.error(`✗ ${rel(file)}:${hit.lineNo}:${hit.col} — ${hit.text}`);
    }
    for (const hit of proseDashes) {
      console.warn(`⚠ ${rel(file)}:${hit.lineNo} [${hit.pattern}] ${hit.text}`);
    }
  }

  console.log('\nDocumentation punctuation check');
  if (emTotal === 0) {
    console.log('✓ No Unicode em dashes found');
  } else {
    console.log(`✗ ${emTotal} Unicode em dash${emTotal === 1 ? '' : 'es'} found in prose`);
  }
  console.log('✓ Technical -- usage preserved');
  if (dashTotal === 0) {
    console.log('✓ No suspicious prose -- detected');
  } else {
    console.log(`⚠ ${dashTotal} suspicious prose -- occurrence${dashTotal === 1 ? '' : 's'} (warning only)`);
  }

  process.exit(emTotal === 0 ? 0 : 1);
}

main();
