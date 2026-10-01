// Obfuscation engine: pure, no DOM or chrome.* dependencies (testable with node).
(function () {
  'use strict';

  const MAX_MATCHES_PER_RULE = 10000;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function labelFor(rule) {
    const base = String(rule.label || rule.name || 'DATA')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return base || 'DATA';
  }

  // Accented variants of each base letter (the regex uses the i+u flags, so uppercase is covered too).
  const ACCENTS = {
    a: 'aáàâäãåā', e: 'eéèêëē', i: 'iíìîïī', o: 'oóòôöõøō', u: 'uúùûüū', n: 'nñ', c: 'cç', y: 'yýÿ'
  };

  // "José  Núñez" -> pattern accepting "jose nunez", "JOSÉ\nNÚÑEZ", decomposed accents (e + ◌́), etc.
  function keywordToRegex(word) {
    const base = word.normalize('NFD').replace(/\p{M}/gu, '');
    let out = '';
    for (const part of base.split(/(\s+)/)) {
      if (/^\s+$/.test(part)) {
        out += '\\s+';
        continue;
      }
      for (const ch of part) {
        const variants = ACCENTS[ch.toLowerCase()];
        out += variants ? `[${variants}]\\p{M}*` : escapeRegex(ch);
      }
    }
    return out;
  }

  function splitKeywords(pattern) {
    return String(pattern)
      .split(/[,\n]/)
      .map((w) => w.trim())
      .filter(Boolean);
  }

  // Returns a global RegExp, or throws if the pattern is invalid.
  function compileRule(rule) {
    if (rule.type === 'keyword') {
      const words = splitKeywords(rule.pattern)
        .sort((a, b) => b.length - a.length)
        .map(keywordToRegex);
      if (!words.length) return null;
      const alt = `(?:${words.join('|')})`;
      // \b does not understand accented letters, so use Unicode lookarounds instead.
      const src = rule.wholeWord === false ? alt : `(?<![\\p{L}\\p{N}_])${alt}(?![\\p{L}\\p{N}_])`;
      return new RegExp(src, 'giu');
    }
    if (!String(rule.pattern || '').trim()) return null;
    let flags = String(rule.flags ?? 'gi').replace(/[^dgimsuvy]/g, '');
    flags = [...new Set(flags)].join('');
    if (!flags.includes('g')) flags += 'g';
    return new RegExp(rule.pattern, flags);
  }

  function validateRule(rule) {
    try {
      compileRule(rule);
      return null;
    } catch (e) {
      return e.message;
    }
  }

  function collectRuleMatches(text, rules, found) {
    (rules || []).forEach((rule, order) => {
      if (!rule || !rule.enabled) return;
      let re;
      try {
        re = compileRule(rule);
      } catch (e) {
        return; // invalid regex: ignored
      }
      if (!re) return;
      let m;
      let n = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        found.push({ start: m.index, end: m.index + m[0].length, value: m[0], rule, order });
        if (++n >= MAX_MATCHES_PER_RULE) break;
      }
    });
  }

  // Resolve overlaps: earliest start wins; on ties the longest; then rule order.
  function resolveOverlaps(found) {
    found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.order - b.order);
    const chosen = [];
    let lastEnd = -1;
    for (const m of found) {
      if (m.start >= lastEnd) {
        chosen.push(m);
        lastEnd = m.end;
      }
    }
    return chosen;
  }

  function findMatches(text, rules) {
    const found = [];
    collectRuleMatches(text, rules, found);
    return resolveOverlaps(found);
  }

  // ---------- Word lists ----------
  // Instead of one giant regex, the text is split into words that are looked up in a Set
  // (linear cost; fine for lists with hundreds of thousands of entries). Multi-word entries are
  // supported ("De la Torre", "Procter & Gamble"), ignoring case, accents and spacing.

  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
  const GAP_RE = /^[\s\-'’.&]{1,4}$/;
  const MAX_WORDS_PER_ENTRY = 6;

  function normalizeTerm(s) {
    return String(s)
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[’`´]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function entryKey(entry) {
    return normalizeTerm(entry).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  let prepared = { lists: null, exceptions: null, value: null };
  function prepareWordlists(lists, exceptions) {
    if (prepared.lists === lists && prepared.exceptions === exceptions) return prepared.value;
    const exc = new Set((exceptions || []).map(entryKey).filter(Boolean));
    let maxWords = 1;
    const out = [];
    const partials = [];
    (lists || []).forEach((l, i) => {
      if (l.enabled === false) return;
      const rule = { id: 'wl:' + l.id, name: l.name, enabled: true };
      if (l.partial) {
        // Partial entries match anywhere, also inside other words ("hooli" in "HooliDC"). There are only a
        // few of them (they come from the user's memory), so a single regex per list is fine.
        const terms = (l.words || []).map((w) => String(w).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
        if (terms.length) partials.push({ re: new RegExp(terms.map(keywordToRegex).join('|'), 'giu'), rule, order: 1000 + i });
        return;
      }
      const set = new Set();
      for (const w of l.words || []) {
        const k = entryKey(w);
        if (!k || (!l.ignoreExceptions && exc.has(k))) continue;
        set.add(k);
        const n = (k.match(WORD_RE) || []).length;
        if (n > maxWords) maxWords = Math.min(n, MAX_WORDS_PER_ENTRY);
      }
      if (!set.size) return;
      out.push({
        set,
        capitalizedOnly: !!l.capitalizedOnly,
        ignoreExceptions: !!l.ignoreExceptions,
        rule,
        order: 1000 + i
      });
    });
    const value = { lists: out, partials, exceptions: exc, maxWords };
    prepared = { lists, exceptions, value };
    return value;
  }

  function collectWordlistMatches(text, settings, found) {
    const prep = prepareWordlists(settings.compiledWordlists, settings.compiledExceptions);
    for (const { re, rule, order } of prep.partials) {
      re.lastIndex = 0;
      let pm;
      while ((pm = re.exec(text)) !== null) {
        if (!pm[0].length) {
          re.lastIndex++;
          continue;
        }
        found.push({ start: pm.index, end: pm.index + pm[0].length, value: pm[0], rule, order });
      }
    }
    if (!prep.lists.length) return;
    const words = [];
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text)) !== null) {
      words.push({ start: m.index, end: m.index + m[0].length, norm: normalizeTerm(m[0]), cap: /^\p{Lu}/u.test(m[0]) });
    }
    for (let i = 0; i < words.length; i++) {
      let key = '';
      let anyCap = false;
      for (let n = 1; n <= prep.maxWords && i + n - 1 < words.length; n++) {
        const w = words[i + n - 1];
        anyCap = anyCap || w.cap;
        if (n > 1) {
          const gap = text.slice(words[i + n - 2].end, w.start);
          if (!GAP_RE.test(gap)) break;
          key += gap.replace(/\s+/g, ' ').replace(/[’`´]/g, "'");
        }
        key += w.norm;
        const excepted = prep.exceptions.has(key);
        for (const l of prep.lists) {
          if (excepted && !l.ignoreExceptions) continue;
          // Multi-word entries count as capitalized if any word is, so lowercase particles work ("de la Cruz").
          if (l.set.has(key) && (!l.capitalizedOnly || anyCap)) {
            found.push({ start: words[i].start, end: w.end, value: text.slice(words[i].start, w.end), rule: l.rule, order: l.order });
          }
        }
      }
    }
  }

  // Values the user chose to never obfuscate (settings.allowlist). Memory entries still win: they are
  // an explicit decision to hide a term.
  let allowPrepared = { list: null, set: new Set() };
  function allowSet(list) {
    if (allowPrepared.list !== list) allowPrepared = { list, set: new Set((list || []).map(entryKey).filter(Boolean)) };
    return allowPrepared.set;
  }

  // Rules + word lists, without overlaps.
  function findAll(text, settings) {
    let found = [];
    collectRuleMatches(text, settings.rules, found);
    collectWordlistMatches(text, settings, found);
    const allow = allowSet(settings.allowlist);
    if (allow.size) found = found.filter((m) => String(m.rule.id || '').startsWith('wl:mem:') || !allow.has(entryKey(m.value)));
    return resolveOverlaps(found);
  }

  // ---------- Suggestions ----------
  // Things that look sensitive but matched nothing, so the user can add them to memory in one click.
  // Simple, explainable heuristics only (no model, nothing leaves the browser):
  //   name   -> capitalized words ("Northwind Traders", "Smithers" mid-sentence)
  //   code   -> identifiers mixing letters and digits or in capitals ("HOOLI_DC", "Xq7mP2vL", "srv-db-01")
  //   host   -> host names ("hooli.local", "db01.internal")
  //   number -> long numbers (meeting IDs, account numbers)
  const COMMON_WORDS = new Set((
    'a an the and or but if of to in on at by for from with about into this that these those it its i you he she we ' +
    'they me my your our their hi hello hey dear thanks thank please regards best cheers kind yes no ok okay mr mrs ms ' +
    'dr team everyone all note subject re fw fwd cc bcc monday tuesday wednesday thursday friday saturday sunday ' +
    'january february march april may june july august september october november december today tomorrow ' +
    'yesterday hola buenas buenos gracias saludos un una el la los las y o de del en con por para lunes martes ' +
    'miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre octubre ' +
    'noviembre diciembre hoy manana ayer company empresa'
  ).split(' '));
  const ACRONYMS = new Set((
    'API URL URI HTTP HTTPS JSON XML HTML CSS SQL CSV PDF DOC DOCX XLSX PNG JPG GIF SVG CEO CTO CFO COO HR IT AI ML ' +
    'LLM GPT CPU GPU RAM SSD USB VPN DNS SSH TLS SSL TCP UDP IP IPV4 IPV6 LAN WAN OK FAQ ASAP FYI EOD ETA UTC GMT CET ' +
    'EU USA UK ID UI UX QA PR KPI ROI SLA NDA RFC TODO README UPDATE NOTE WARNING ERROR INFO DEBUG'
  ).split(' '));
  const CONNECTORS = new Set('de del la las los da das do dos di du van von der den le y e of and &'.split(' '));
  const FILE_EXTENSIONS = new Set('js ts jsx tsx py rb go rs java kt md txt json yaml yml xml html htm css scss png jpg jpeg gif svg pdf doc docx xls xlsx csv zip gz tar log sh exe dll'.split(' '));
  const PLACEHOLDER_RE = /\[[A-Z][A-Z0-9_]*_\d+\]/g;

  function suggest(text, settings, dismissed = []) {
    const busy = findAll(text, settings).map((m) => [m.start, m.end]);
    PLACEHOLDER_RE.lastIndex = 0;
    let pm;
    while ((pm = PLACEHOLDER_RE.exec(text)) !== null) busy.push([pm.index, pm.index + pm[0].length]);
    const overlaps = (s, e) => busy.some(([a, b]) => s < b && e > a);
    const skip = new Set([...(dismissed || []), ...(settings.allowlist || []), ...(settings.compiledExceptions || [])].map(entryKey));
    const out = new Map();
    const add = (value, kind, start) => {
      const key = entryKey(value);
      if (!key || skip.has(key)) return;
      if (out.has(key)) out.get(key).count++;
      else out.set(key, { value, kind, count: 1, start });
    };

    // Codes, host names and long numbers.
    const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}_.\-]*[\p{L}\p{N}]/gu;
    let t;
    while ((t = TOKEN_RE.exec(text)) !== null) {
      const v = t[0];
      const s = t.index;
      const e = s + v.length;
      if (overlaps(s, e)) continue;
      const letters = /\p{L}/u.test(v);
      const digits = /\d/.test(v);
      let kind = null;
      if (!letters && v.replace(/\D/g, '').length >= 7) kind = 'number';
      else if (letters && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) && !FILE_EXTENSIONS.has(v.split('.').pop().toLowerCase()) && !/^v?\d+(\.\d+)*$/i.test(v)) kind = 'host';
      else if (letters && v.length >= 5 && (digits || v.includes('_')) && /^[\p{L}\p{N}_\-]+$/u.test(v)) kind = 'code';
      else if (letters && /^[\p{Lu}\d_]{3,}$/u.test(v) && !ACRONYMS.has(v.replace(/[\d_]/g, ''))) kind = 'code';
      if (kind) {
        add(v, kind, s);
        busy.push([s, e]);
      }
    }
    // Long numbers written in groups ("987 654 321 098 765").
    const GROUPED_RE = /\d{2,}(?:[ \-]\d{2,}){2,}/g;
    while ((t = GROUPED_RE.exec(text)) !== null) {
      if (t[0].replace(/\D/g, '').length >= 7 && !overlaps(t.index, t.index + t[0].length)) {
        add(t[0], 'number', t.index);
        busy.push([t.index, t.index + t[0].length]);
      }
    }

    // Runs of capitalized words, allowing lowercase connectors inside ("Miguel de la Cruz").
    const words = [];
    const W_RE = /[\p{L}\p{M}][\p{L}\p{M}'’]*|&/gu;
    while ((t = W_RE.exec(text)) !== null) words.push({ w: t[0], s: t.index, e: t.index + t[0].length });
    const isCap = (w) => /^\p{Lu}/u.test(w) && !/^[\p{Lu}\d_]{2,}$/u.test(w);
    const sentenceStart = (pos) => /(^|[.!?:;\n"“(\[]\s*)$/.test(text.slice(Math.max(0, pos - 3), pos)) || pos === 0;
    for (let i = 0; i < words.length; i++) {
      if (!isCap(words[i].w) || overlaps(words[i].s, words[i].e)) continue;
      const run = [words[i]];
      let j = i + 1;
      while (j < words.length) {
        const gapOk = /^[ \t]+$/.test(text.slice(run[run.length - 1].e, words[j].s));
        if (!gapOk || overlaps(words[j].s, words[j].e)) break;
        if (isCap(words[j].w)) {
          run.push(words[j]);
          j++;
        } else if (CONNECTORS.has(words[j].w.toLowerCase()) && j + 1 < words.length && isCap(words[j + 1].w) &&
          /^[ \t]+$/.test(text.slice(words[j].e, words[j + 1].s))) {
          run.push(words[j], words[j + 1]);
          j += 2;
        } else break;
      }
      i = j - 1;
      // Trim common words at both ends ("Hi", "Thanks", "Company").
      while (run.length && COMMON_WORDS.has(run[0].w.toLowerCase())) run.shift();
      while (run.length && (COMMON_WORDS.has(run[run.length - 1].w.toLowerCase()) || CONNECTORS.has(run[run.length - 1].w.toLowerCase()))) run.pop();
      if (!run.length) continue;
      const capitalized = run.filter((r) => isCap(r.w)).length;
      if (capitalized === 1 && (sentenceStart(run[0].s) || run[0].w.length < 3)) continue; // "Could", "Our"...
      add(text.slice(run[0].s, run[run.length - 1].e), 'name', run[0].s);
    }
    return [...out.values()].sort((a, b) => a.start - b.start).slice(0, 25).map(({ value, kind, count }) => ({ value, kind, count }));
  }

  // Session: value <-> placeholder mapping. The same value always gets the same placeholder,
  // and a placeholder can be translated back to the original (restore).
  function createSession() {
    return { map: new Map(), reverse: new Map(), counters: Object.create(null) };
  }

  // Case, accents and spacing are ignored: "JOSÉ  NÚÑEZ" and "jose nunez" are the same value.
  function keyFor(label, value) {
    return label + '\u0000' + normalizeTerm(value);
  }

  // Registers an already assigned placeholder (e.g. loaded from storage or assigned by the background).
  function addEntry(session, token, label, value) {
    session.map.set(keyFor(label, value), token);
    session.reverse.set(token, value);
    const n = Number(/_(\d+)\]$/.exec(token)?.[1] || 0);
    if (n > (session.counters[label] || 0)) session.counters[label] = n;
  }

  function placeholderFor(value, label, session) {
    let token = session.map.get(keyFor(label, value));
    if (!token) {
      token = `[${label}_${(session.counters[label] || 0) + 1}]`;
      addEntry(session, token, label, value);
    }
    return token;
  }

  function usesPlaceholder(match, settings) {
    return !match.rule.replacement && (settings.mode || 'placeholder') === 'placeholder';
  }

  // {label, value} pairs that would need a new placeholder (not yet in the session).
  function pendingPlaceholders(matches, settings, session) {
    const seen = new Set();
    const out = [];
    for (const m of matches) {
      if (!usesPlaceholder(m, settings)) continue;
      const label = labelFor(m.rule);
      const key = keyFor(label, m.value);
      if (session.map.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ label, value: m.value });
    }
    return out;
  }

  function replacementFor(match, settings, session) {
    const { rule, value } = match;
    if (rule.replacement) return rule.replacement;
    switch (settings.mode) {
      case 'asterisks':
        return value.replace(/[^\s]/gu, '*');
      case 'mask':
        return settings.maskText || '[REDACTED]';
      case 'placeholder':
      default:
        return placeholderFor(value, labelFor(rule), session);
    }
  }

  function obfuscate(text, settings, session, matches) {
    session = session || createSession();
    matches = matches || findAll(text, settings);
    if (!matches.length) return { text, count: 0, matches: [] };

    let out = '';
    let pos = 0;
    const details = [];
    for (const m of matches) {
      const repl = replacementFor(m, settings, session);
      out += text.slice(pos, m.start) + repl;
      pos = m.end;
      details.push({ rule: m.rule.name || labelFor(m.rule), original: m.value, replacement: repl });
    }
    out += text.slice(pos);
    return { text: out, count: matches.length, matches: details };
  }

  // Regex matching known placeholders with or without brackets ("[EMAIL_1]" or "EMAIL_1"),
  // because LLMs sometimes rewrite them without brackets.
  function buildRestoreRegex(session) {
    if (!session.reverse.size) return null;
    const names = [...session.reverse.keys()]
      .map((t) => t.slice(1, -1))
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex);
    return new RegExp(`\\[?(?<![A-Za-z0-9_])(${names.join('|')})(?![A-Za-z0-9_])\\]?`, 'g');
  }

  // escape: optional, for inserting the original into HTML.
  function restore(text, session, re, escape) {
    re = re || buildRestoreRegex(session);
    if (!re) return text;
    re.lastIndex = 0;
    return text.replace(re, (all, name) => {
      const original = session.reverse.get(`[${name}]`);
      if (original == null) return all;
      return escape ? escape(original) : original;
    });
  }

  const api = {
    obfuscate,
    createSession,
    addEntry,
    placeholderFor,
    pendingPlaceholders,
    findMatches,
    findAll,
    suggest,
    replacementFor,
    normalizeTerm,
    buildRestoreRegex,
    restore,
    compileRule,
    validateRule,
    labelFor,
    escapeRegex
  };
  globalThis.TrellisEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
