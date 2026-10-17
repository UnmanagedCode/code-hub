import vm from 'node:vm';

// One concern: matching a manifest's `readyWhen` regex against app output
// without letting a pathological pattern stall the event loop.
export const READY_WINDOW_CHARS = 2048;    // max chars one regex test sees
export const READY_OVERLAP_CHARS = 1024;   // re-scanned tail so a match straddling a boundary is not lost
export const READY_MATCH_DEADLINE_MS = 250; // per-tick budget for all slices; exceeding it fails readiness

const DEADLINE_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';

// A vm timeout is the only way to interrupt a running RegExp. One context and
// script are shared: each call is synchronous, so nothing interleaves.
const ctx = vm.createContext({});
const script = new vm.Script('found = false; for (const t of slices) if (re.test(t)) { found = true; break; }');

// Parse the quantifier starting at source[i]; returns { end, repeats } or null.
// `?`, `{n}` and `{0,1}` are not repeating; an unparseable `{` is a literal.
function quantifierAt(source, i) {
  let end = i;
  let repeats;
  const c = source[i];
  if (c === '*' || c === '+') {
    end = i + 1;
    repeats = true;
  } else if (c === '?') {
    end = i + 1;
    repeats = false;
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (!m) return null;
    end = i + m[0].length;
    repeats = m[2] === undefined ? false : m[3] === '' || Number(m[3]) >= 2;
  } else {
    return null;
  }
  if (source[end] === '?') end++; // lazy
  return { end, repeats };
}

// Star height >= 2: a repeated group that contains a repeating quantifier.
// Returns the offending group (with its quantifier) or null.
function findNestedQuantifier(source) {
  const stack = [{ start: 0, repeats: false }];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '(') {
      stack.push({ start: i, repeats: false });
      i++;
    } else if (c === ')' && stack.length > 1) {
      const f = stack.pop();
      const q = quantifierAt(source, i + 1);
      if (q?.repeats && f.repeats) return source.slice(f.start, q.end);
      if (f.repeats || q?.repeats) stack[stack.length - 1].repeats = true;
      i = q ? q.end : i + 1;
    } else {
      const q = quantifierAt(source, i);
      if (q) {
        if (q.repeats) stack[stack.length - 1].repeats = true;
        i = q.end;
      } else {
        i++;
      }
    }
  }
  return null;
}

// Load-time check: a message fragment describing why `source` is rejected, or
// null. The caller prefixes the file and field.
export function readyWhenProblem(source) {
  try {
    new RegExp(source);
  } catch (e) {
    return `is not a valid regular expression (${e.message})`;
  }
  const fragment = findNestedQuantifier(source);
  if (fragment) {
    return `nests a repeating quantifier inside a repeated group ("${fragment}"); this shape is rejected because patterns of it can backtrack exponentially on output that doesn't match — rewrite it so no repeated group contains a repeating quantifier`;
  }
  return null;
}

// `scan(output, total)`: `output` is the retained output ring, `total` the
// count of chars ever appended. Tests only what is new since the last scan plus
// READY_OVERLAP_CHARS, in READY_WINDOW_CHARS slices, under one deadline.
export function createReadyMatcher(source) {
  const re = new RegExp(source);
  let scannedTo = 0;
  return {
    scan(output, total) {
      const fresh = total - scannedTo;
      scannedTo = total;
      const slices = [];
      for (let i = Math.max(0, output.length - fresh - READY_OVERLAP_CHARS); ; i += READY_WINDOW_CHARS - READY_OVERLAP_CHARS) {
        slices.push(output.slice(i, i + READY_WINDOW_CHARS));
        if (i + READY_WINDOW_CHARS >= output.length) break;
      }
      ctx.re = re;
      ctx.slices = slices;
      try {
        script.runInContext(ctx, { timeout: READY_MATCH_DEADLINE_MS });
        return ctx.found === true;
      } catch (e) {
        if (e.code === DEADLINE_CODE) {
          throw new Error(`readyWhen /${source}/ exceeded its ${READY_MATCH_DEADLINE_MS}ms match deadline and was stopped — simplify the pattern`);
        }
        throw e;
      } finally {
        ctx.slices = null;
        ctx.re = null;
      }
    },
  };
}
