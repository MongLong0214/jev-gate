/**
 * The credential screen, copied from `src/lean-source.ts` because a Function Hooks module cannot import from the
 * Node side of the repository. `tests/router/secret-parity.test.ts` fails when the two lists drift.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // A quoted value, or a long unbroken token. `password = readPassword();` is a call, not a credential.
  /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*(?:["'`][^"'`\s]{12,}["'`]|[A-Za-z0-9_\-./+=]{16,})/i,
  // `Authorization: Bearer <value>` in any header syntax -- `: `, `=`, an object key, a subscript assignment, a call
  // argument -- so up to eight punctuation characters sit between the word and the scheme. Any literal value counts,
  // however short (`Basic dTpw` is a whole credential), including one reached through a constant template expression
  // (`${'dTpw'}`) or a literal concatenation (`'Basic ' + 'dTpw'`). A name or a placeholder does not (`$TOKEN`,
  // `${token}`, `'Bearer ' + token`, `<token>`, `{{token}}`, `%TOKEN%`): none starts with a token character or a quote.
  // Prose that puts a word there ("Authorization: Bearer header") is screened too. One line break may sit in that
  // punctuation, because a call's arguments are often wrapped (`headers.set("Authorization",\n  "Basic dTpw")`), and
  // whitespace does not count toward the eight: indentation and column alignment run far wider, so each gap has its
  // own bound of 64. Whitespace and punctuation are disjoint classes, so the repetition cannot backtrack. `[ \t]` was
  // rejected for the gaps: the class it replaces matched a no-break space, and `Authorization:\u00a0Basic` must screen.
  /\bauthorization\b(?:[^\S\n]{0,64}[^\w\s]){0,8}[^\S\n]{0,64}(?:\n(?:[^\S\n]{0,64}[^\w\s]){0,8}[^\S\n]{0,64})?(?:bearer|basic|token)\s+(?:["'`]\s*\+\s*["'`]|\$\{\s*["'`])?[A-Za-z0-9_\-.~+/]+/i,
  // A Basic credential encoded at run time from a literal `user:password`; a template with a `${...}` in it is names.
  /\b(?:btoa|Buffer\.from)\(\s*["'`][^"'`\n:${]{0,256}:[^"'`\n${]{1,256}["'`]/,
  // A password in a URL's userinfo (`postgres://user:secret@host`), percent-encoded or not (`%40secret`). A
  // placeholder is a name: `${PASS}`, `<pass>`, `{pass}`, `%PASS%`, and a `%` that starts no escape (`%s`, `%(pw)s`).
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/?#@:"'`]{1,64}:(?![$<{]|%(?![0-9A-Fa-f]{2})|%[A-Za-z_]\w*%@)[^\s/?#@"'`]{1,128}@/i,
  // A bearer token outside a header line, whatever its prefix. The digit keeps "bearer" in prose from matching.
  /\b[Bb]earer\s+(?=[A-Za-z0-9_\-.~+/]*\d)[A-Za-z0-9_\-.~+/]{16,}/,
];

export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some((re) => re.test(text));
