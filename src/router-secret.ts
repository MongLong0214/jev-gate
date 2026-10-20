/**
 * The credential screen, copied from `src/outbound-text.ts` because a Function Hooks module cannot import from the
 * Node side of the repository. `tests/router/secret-parity.test.ts` fails when the two lists drift.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36,}\b/,
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
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
  // Cookie headers and curl's inline cookie argument carry credentials even when the cookie name is unfamiliar.
  /\b(?:set-cookie|cookie)\s*:\s*["'`]?[A-Za-z0-9_.-]+\s*=\s*["'`]?[A-Za-z0-9_%+./~=-]+/i,
  /(?:^|\s)(?:--cookie(?:=|\s+)|-b\s*)["'`]?[A-Za-z0-9_.-]+\s*=\s*["'`]?[A-Za-z0-9_%+./~=-]+/i,
  // A bearer token outside a header line, whatever its prefix. The digit keeps "bearer" in prose from matching.
  /\b[Bb]earer\s+(?=[A-Za-z0-9_\-.~+/]*\d)[A-Za-z0-9_\-.~+/]{16,}/,
];

// Keys may be bare or quoted in JSON, YAML, shell and code. Capture the complete value before screening it so a
// prefix of a placeholder or a function call cannot be mistaken for a credential.
const ASSIGNMENT_VALUE = String.raw`(?:"([^"\r\n]*)"|'([^'\r\n]*)'|\x60([^\x60\r\n]*)\x60|([A-Za-z0-9_%+./~:=@!-]+))`;
const CREDENTIAL_KEYS = String.raw`authorization|auth|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|(?:access|refresh|id)[_-]?token|client[_-]?secret|password|passwd|pwd|secret|token|credentials?|aws_access_key_id|aws_secret_access_key|aws_session_token`;
const CREDENTIAL_KEY = new RegExp(String.raw`^(?:${CREDENTIAL_KEYS})$`, 'i');
const GENERIC_CREDENTIAL_KEY = /^(?:authorization|auth|pwd|secret|token|credentials?)$/i;
// Shell/.env assignments may prefix the key with an application name (`DB_PASSWORD`), at the start of a line.
const CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`(?:\b|^[ \t]*(?:export[ \t]+)?[A-Z_][A-Z0-9_]*_)(${CREDENTIAL_KEYS})\b["'\x60]?\s*(?:=>|[:=])\s*` + ASSIGNMENT_VALUE, 'gim');
const COOKIE_ASSIGNMENT = new RegExp(String.raw`(?:^|[^\w.-])(sessionid|session|sid|connect\.sid|PHPSESSID|JSESSIONID|_session|[\w.-]*(?:auth(?:entication)?|token)(?:[_.-][\w.-]*|cookie|token|session)?)["'\x60]?\s*(?:=>|[:=])\s*` + ASSIGNMENT_VALUE, 'gi');
const NETRC_PASSWORD = new RegExp(String.raw`^[ \t]*(password)[ \t]+` + ASSIGNMENT_VALUE + String.raw`[ \t]*\r?$`, 'gim');

const literalAssignment = (text: string, pattern: RegExp, minLength = 1): boolean => {
  for (const match of text.matchAll(pattern)) {
    // Credential keys own their thresholds; the broader cookie-name pattern must not bypass them.
    if (pattern === COOKIE_ASSIGNMENT && CREDENTIAL_KEY.test(match[1]!)) continue;
    const value = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    // Like the header and URL screens, names/templates are not literal credentials. Empty and fully masked values
    // carry no credential; xxx and changeme are conventional placeholders too, even when they reach the session-cookie length threshold.
    if (value.length < minLength || /^(?:[$<{]|%(?![0-9A-Fa-f]{2}))|^\*+$|^x+$|^changeme$/i.test(value) || /%[A-Za-z_]\w*%$/.test(value) || value.includes('${')) continue;
    // The header patterns above own schemes, including their placeholder, concatenation and whitespace rules.
    if (/^authorization$/i.test(match[1]!) && /^(?:bearer|basic|token)(?:\s|$)/i.test(value)) continue;
    const quoted = match[5] === undefined;
    const hasDigit = /\d/.test(value);
    const identifier = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value);
    const generic = pattern === COOKIE_ASSIGNMENT || GENERIC_CREDENTIAL_KEY.test(match[1]!);
    // Dotted paths always name another value. Strong keys permit alphabetic literals, excluding primitive/type
    // names; generic keys and session cookies still exclude digit-free identifiers such as tokenValue.
    const reference = identifier && (value.includes('.') || (generic ? !hasDigit
      : /^(?:string|number|bigint|boolean|symbol|object|undefined|null|any|unknown|never|void)$/i.test(value)));
    if (!quoted && (reference || /^[~/]/.test(value)
      || /^\s*(?:[.(\[]|\?\.)/.test(text.slice(match.index! + match[0].length)))) continue;
    // Bare session cookies retain D1's eight-character threshold, excluding names even when quoted.
    if (pattern === COOKIE_ASSIGNMENT) { if (!reference) return true; continue; }
    // Strong keys accept any quoted literal, or an unquoted literal of at least eight characters. Generic keys
    // retain their value-shape thresholds, including quoted options such as credentials: 'include'.
    if (!generic && (quoted || value.length >= 8)) return true;
    if ((value.length >= 8 && hasDigit)
      || (value.length >= 16 && /^[A-Za-z0-9_%+./~:=@!-]+$/.test(value) && !identifier)) return true;
  }
  return false;
};

export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some((re) => re.test(text))
  || literalAssignment(text, CREDENTIAL_ASSIGNMENT)
  || literalAssignment(text, COOKIE_ASSIGNMENT, 8)
  || literalAssignment(text, NETRC_PASSWORD);
