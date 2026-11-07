'use strict';
// Minimal line diff (LCS) producing unified-diff hunks — enough for "receipts" on stage.

const MAX_CELLS = 4_000_000;

function diffLines(a, b) {
  const A = a === '' ? [] : a.replace(/\r\n/g, '\n').split('\n');
  const B = b === '' ? [] : b.replace(/\r\n/g, '\n').split('\n');
  const n = A.length;
  const m = B.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    return [...A.map((l) => ({ op: '-', line: l })), ...B.map((l) => ({ op: '+', line: l }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ op: ' ', line: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: '-', line: A[i++] });
    else ops.push({ op: '+', line: B[j++] });
  }
  while (i < n) ops.push({ op: '-', line: A[i++] });
  while (j < m) ops.push({ op: '+', line: B[j++] });
  return ops;
}

function unifiedDiff(file, before, after, context = 3) {
  const ops = diffLines(before ?? '', after ?? '');
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === '+') added++;
    if (o.op === '-') removed++;
  }
  if (!added && !removed) return { file, added, removed, text: '' };
  // Build hunks
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  let aLine = 1;
  let bLine = 1;
  const pos = ops.map((o) => {
    const p = { ...o, a: aLine, b: bLine };
    if (o.op !== '+') aLine++;
    if (o.op !== '-') bLine++;
    return p;
  });
  const changed = pos.map((o, idx) => (o.op !== ' ' ? idx : -1)).filter((x) => x >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - context);
    let end = Math.min(pos.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(pos.length - 1, changed[k] + context);
    }
    const slice = pos.slice(start, end + 1);
    const aCount = slice.filter((o) => o.op !== '+').length;
    const bCount = slice.filter((o) => o.op !== '-').length;
    lines.push(`@@ -${slice[0].a},${aCount} +${slice[0].b},${bCount} @@`);
    for (const o of slice) lines.push(`${o.op}${o.line}`);
    k++;
  }
  return { file, added, removed, text: lines.join('\n') };
}

module.exports = { diffLines, unifiedDiff };
