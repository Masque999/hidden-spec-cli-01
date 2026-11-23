// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.fin ? s.br : '');
}

/** One line compared at a tier (SPEC.md section 5). */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at a tier, at or after `from`; occurrences may overlap. */
function occurrences(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(fileLines[i + k]!, tier) !== normLine(o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..maxTier) at which O occurs at or after `from`, and its positions. */
function findTier(fileLines: string[], o: string[], from: number, maxTier: number): { tier: number; pos: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrences(fileLines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The leading spaces and tabs of a line. */
function lead(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** Old and new lines of one hunk, chunk or block; ctx maps a new line's index to its old line's index for context lines. */
interface Patch {
  o: string[];
  n: string[];
  ctx: Map<number, number>;
}

/** The lines N writes in place of the matched lines at `at`: context lines as the file's own, other lines re-indented at tier 2. */
function buildNew(fileLines: string[], at: number, p: Patch, tier: number): string[] {
  const out: string[] = [];
  const f = lead(fileLines[at] ?? '');
  const pp = lead(p.o[0] ?? '');
  for (let j = 0; j < p.n.length; j++) {
    const oi = p.ctx.get(j);
    if (oi !== undefined) {
      out.push(fileLines[at + oi]!);
      continue;
    }
    let line = p.n[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(pp)) line = f + line.slice(pp.length);
    out.push(line);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk: ' ' context, '-' old, '+' new, '\' backslash, '' empty context. */
interface BodyLine {
  t: string;
  s: string;
}

interface Hunk extends Patch {
  a: number;
  plus: string[];
  lastNoNL: boolean;
  lastPlusNoNL: boolean;
}

function hunkFromBody(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const plus: string[] = [];
  const ctx = new Map<number, number>();
  for (const b of body) {
    if (b.t === ' ' || b.t === '') {
      ctx.set(n.length, o.length);
      o.push(b.s);
      n.push(b.s);
    } else if (b.t === '-') o.push(b.s);
    else if (b.t === '+') {
      plus.push(b.s);
      n.push(b.s);
    }
  }
  let lastNoNL = false;
  for (let j = body.length - 1; j >= 0; j--) {
    const b = body[j]!;
    if (b.t === ' ' || b.t === '' || b.t === '+') {
      lastNoNL = j + 1 < body.length && body[j + 1]!.t === '\\';
      break;
    }
  }
  let lastPlusNoNL = false;
  for (let j = body.length - 1; j >= 0; j--) {
    const b = body[j]!;
    if (b.t === '+') {
      lastPlusNoNL = j + 1 < body.length && body[j + 1]!.t === '\\';
      break;
    }
  }
  return { a, o, n, ctx, plus, lastNoNL, lastPlusNoNL };
}

interface Section {
  oldP: string | null;
  newP: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: the text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function uniPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let sec: Section | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldP: null, newP: null, diffOld: m[1]!, diffNew: m[2]!, create: false, del: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldP: null, newP: null, diffOld: null, diffNew: null, create: false, del: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    sections.push(sec);
    let inHeader = true;
    let pairOld: string | null = null;
    let pairNew: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        inHeader = false;
        const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = Number(hm[1]);
        i++;
        const body: BodyLine[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            body.push({ t: b === '' ? '' : b[0]!, s: b === '' ? '' : b.slice(1) });
            i++;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1]!.t === '') body.pop();
        sec.hunks.push(hunkFromBody(a, body));
        continue;
      }
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (inHeader) {
          pairOld = uniPath(l);
          pairNew = uniPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        break;
      }
      if (inHeader) {
        if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
        if (l.startsWith('rename from ')) renOld = l.slice(12).trim();
        else if (l.startsWith('rename to ')) renNew = l.slice(10).trim();
        else if (l.startsWith('new file mode')) sec.create = true;
        else if (l.startsWith('deleted file mode')) sec.del = true;
        i++;
        continue;
      }
      i++;
    }
    sec.oldP = pairOld ?? renOld ?? sec.diffOld;
    sec.newP = pairNew ?? renNew ?? sec.diffNew;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; the result's text. */
function applyHunks(text: string, hunks: Hunk[], maxTier: number, path: string): string {
  const s = splitFile(text);
  const lines = [...s.lines];
  let fin = s.fin;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(lines, h.o, 0, maxTier);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dd = Math.abs(p - target);
        if (dd < bestDist) {
          best = p;
          bestDist = dd;
        }
      }
      const ranToEnd = best + h.o.length === lines.length;
      const rep = buildNew(lines, best, h, found.tier);
      lines.splice(best, h.o.length, ...rep);
      if (ranToEnd) {
        const hasCtxPlus = h.ctx.size > 0 || h.n.length > h.ctx.size;
        fin = hasCtxPlus ? !h.lastNoNL : true;
      }
      d += h.n.length - h.o.length;
    } else {
      let at = h.a + d;
      if (at > lines.length) at = lines.length;
      const wasEnd = at === lines.length;
      lines.splice(at, 0, ...h.n);
      if (wasEnd && h.n.length > 0) fin = !h.lastNoNL;
      d += h.n.length;
    }
  }
  return joinFile({ lines, br: s.br, fin });
}

function unifiedEdit(sec: Section, maxTier: number, moves: { old: string; nw: string }[]): Edit {
  return (tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.create;
    const isDelete = !isCreate && (newP === null || sec.del);
    if (isCreate) {
      const target = newP ?? oldP;
      if (target === null) return;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) plus.push(...h.plus);
      let lastPlusNoNL = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.plus.length > 0) {
          lastPlusNoNL = sec.hunks[k]!.lastPlusNoNL;
          break;
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNL ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP ?? newP;
      if (target === null) return;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(tree.get(oldP)!, sec.hunks, maxTier, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      moves.push({ old: oldP, nw: newP });
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(tree.get(p)!, sec.hunks, maxTier, p));
  };
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], maxTier: number): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const s = splitFile(cur);
    const found = findTier(s.lines, oldLines, 0, maxTier);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const rep = buildNew(s.lines, at, { o: oldLines, n: newLines, ctx: new Map() }, found.tier);
    const out = [...s.lines];
    out.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile({ lines: out, br: s.br, fin: s.fin }));
  };
}

function parseSearchReplace(lines: string[], maxTier: number): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    let j = i + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    let k = eq + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let m = i - 1; m > prevEnd; m--) {
      const t = lines[m]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), maxTier));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface V4aChunk extends Patch {
  anchor: string | null;
  eof: boolean;
}

function v4aChunkON(body: string[]): Patch {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const b of body) {
    if (b.startsWith(' ')) {
      ctx.set(n.length, o.length);
      o.push(b.slice(1));
      n.push(b.slice(1));
    } else if (b === '') {
      ctx.set(n.length, o.length);
      o.push('');
      n.push('');
    } else if (b.startsWith('-')) o.push(b.slice(1));
    else if (b.startsWith('+')) n.push(b.slice(1));
  }
  return { o, n, ctx };
}

function parseV4a(lines: string[], maxTier: number, moves: { old: string; nw: string }[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: string | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const bodyIdx: number[] = [];
    while (i < last) {
      const b = lines[i]!;
      if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
      bodyIdx.push(i);
      i++;
    }
    while (bodyIdx.length > 0 && blank(lines[bodyIdx[bodyIdx.length - 1]!]!)) bodyIdx.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const idx of bodyIdx) {
        const b = lines[idx]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (bodyIdx.length > 0) throw new Exit2(`error: parse ${bodyIdx[0]! + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let pos = 0;
      if (pos < bodyIdx.length && lines[bodyIdx[pos]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[bodyIdx[pos]!]!.slice('*** Move to: '.length).trim();
        pos++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      for (; pos < bodyIdx.length; pos++) {
        const idx = bodyIdx[pos]!;
        const b = lines[idx]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], ctx: new Map() };
          (cur as { body: string[] }).body = [];
          firstChunk = false;
        } else if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${idx + 1}`);
            cur = { anchor: null, eof: false, o: [], n: [], ctx: new Map() };
            (cur as { body: string[] }).body = [];
          }
          (cur as { body: string[] }).body.push(b);
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      for (const c of chunks) {
        const on = v4aChunkON((c as { body: string[] }).body);
        c.o = on.o;
        c.n = on.n;
        c.ctx = on.ctx;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const curText = tree.get(path);
        if (curText === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const s = splitFile(curText);
        const fileLines = [...s.lines];
        let cursor = 0;
        for (const c of chunks) {
          if (c.anchor !== null) {
            let foundAt = -1;
            for (let t = 0; t <= maxTier && foundAt < 0; t++) {
              for (let k = cursor; k < fileLines.length; k++) {
                if (normLine(fileLines[k]!, t) === normLine(c.anchor, t)) {
                  foundAt = k;
                  break;
                }
              }
            }
            if (foundAt < 0) throw new Fail('no-match', path);
            cursor = foundAt + 1;
          }
          if (c.o.length === 0) {
            const at = c.eof ? fileLines.length : cursor;
            fileLines.splice(at, 0, ...c.n);
            cursor = at + c.n.length;
          } else {
            const found = findTier(fileLines, c.o, cursor, maxTier);
            if (found === null) throw new Fail('no-match', path);
            let at = found.pos[0]!;
            if (c.eof) {
              const ok = found.pos.filter((p) => p + c.o.length === fileLines.length);
              if (ok.length === 0) throw new Fail('no-match', path);
              at = ok[0]!;
            }
            const rep = buildNew(fileLines, at, c, found.tier);
            fileLines.splice(at, c.o.length, ...rep);
            cursor = at + rep.length;
          }
        }
        const out = joinFile({ lines: fileLines, br: s.br, fin: s.fin });
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(path, null);
          moves.push({ old: path, nw: moveTo });
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: { old: string; nw: string }[] = [];
  const maxTier = strict ? 0 : 2;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((sec) => unifiedEdit(sec, maxTier, moves));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, maxTier);
    else edits = parseV4a(lines, maxTier, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      movedOld.add(m.old);
      movedNew.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
