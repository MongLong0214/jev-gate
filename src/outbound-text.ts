/**
 * Checks applied to text before it leaves the machine. The gate hook and the recent-prompt context use them, and
 * `src/router-secret.ts` carries a copy of the screen that `tests/router/secret-parity.test.ts` keeps identical.
 */

/**
 * Best-effort local screening of conventional credential shapes, applied to the ORIGINAL string before any JSON
 * escaping. This is a guard against the obvious, not a privacy guarantee and not universal detection: private
 * non-secret text still leaves the machine when a feature that sends it is enabled.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // Jev's own prefix; validApiKey imposes no issuer-specific suffix length.
  /jv_live_[A-Za-z0-9_-]+/i,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\bya29\.[A-Za-z0-9_-]{16,}/,
  /\bnpm_[A-Za-z0-9]{36,}\b/,
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // A bearer token outside a header line, whatever its prefix. The digit keeps "bearer" in prose from matching.
  /\b[Bb]earer\s+(?=[A-Za-z0-9_\-.~+/]*\d)[A-Za-z0-9_\-.~+/]{16,}/,
];

// Capture references and their literal neighbours together, including complete call/member/subscript suffixes.
// Recognising one token is never grounds for discarding the rest of a value.
const TEMPLATE_VALUE = String.raw`\$\{\{[^{}\r\n]*\}\}|\$\{[^{}\r\n]*\}|\{\{[^{}\r\n]*\}\}|\{[^{}\r\n]*\}|<[^<>\r\n]*>`;
const BARE_VALUE = String.raw`(?:${TEMPLATE_VALUE}|\$(?!\{)|[A-Za-z0-9_%+./~:=@!?*-]|[ \t]*(?:\([^()\r\n]*\)|\[[^\[\]\r\n]*\])|[ \t]+(?:\?\.|\.)[ \t]*[A-Za-z_$][\w$]*)+`;
// Freeze the greedy bare value before a caller tests a suffix (notably netrc line endings).
// Its alternatives end in non-whitespace, so shortening it cannot help a trailing whitespace/end check.
const ASSIGNMENT_VALUE = String.raw`(?:"([^"\r\n]*)"|'([^'\r\n]*)'|\x60([^\x60\r\n]*)\x60|(?=(?<bareValue>${BARE_VALUE}))\k<bareValue>)`;

// Shell operators carry literal fallback/alternate/error text. Expand balanced expressions from the inside out,
// retaining plain references (including an empty default) for the same placeholder rules as every other value.
// A stack also handles nested references without a recursion limit or discarding a literal beside a reference.
const shellLiterals = (text: string): string => {
  const frames = [{ opening: '', value: '' }];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{' || (ch === '$' && text[i + 1] === '{')) {
      frames.push({ opening: ch === '$' ? '${' : ch, value: '' });
      if (ch === '$') i++;
    } else if (ch === '}' && frames.length > 1) {
      const frame = frames.pop()!;
      const fallback = frame.opening === '${' ? /^([A-Za-z_]\w*)(?::-|:=|:\?|:\+|-|=)([\s\S]*)$/.exec(frame.value) : null;
      // Remove shell references within the operator's text before judging its whole literal. Preserve the other
      // placeholder shapes, so a partial mask such as <redacted>x still leaves its literal x to the key rules.
      const value = fallback?.[2]?.replace(/\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*/g, '') ?? '';
      frames[frames.length - 1]!.value += fallback
        ? (literalRemainder(fallback[2]!) ? value : '') || '${' + fallback[1] + '}'
        : frame.opening + frame.value + ch;
    } else frames[frames.length - 1]!.value += ch;
  }
  // Preserve an unfinished expression rather than dropping its contents.
  return frames.map(frame => frame.opening + frame.value).join('');
};

// Only whole masks are placeholders. In mixed values remove complete reference tokens and judge the literal
// remainder with the caller's existing thresholds. Separators between names (${USER}:${PASS}) carry no credential.
const literalRemainder = (value: string): string => {
  if (/^(?:\*+|x+|changeme)$/i.test(value)) return '';
  const expanded = value.replace(/\$\{\s*(["'`])([^"'`\r\n]*)\1\s*\}/g, '$2');
  const literal = expanded
    .replace(/\$\{\{[^{}\r\n]*\}\}|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%|<[^<>\r\n]*>|\{\{[^{}\r\n]*\}\}|(?<!\$)\{[^{}\r\n]*\}|\[[A-Za-z_]\w*\]|%\([A-Za-z_]\w*\)[a-z]|%(?![0-9A-Fa-f]{2})[a-z]/gi, '')
    .trim();
  return literal !== expanded.trim() && /^[\s:;,/|+=._@-]*$/.test(literal) ? '' : literal;
};
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const CODE_ROOT = /^(?:process|this|self|cls|config|conf|settings|env|os|req|request|res|response|ctx|context|options|opts|args|argv|params|input|data|body|props|state|user|session|window|globalThis|import|module|exports|app|client|secrets|vars|inputs|matrix|github|decoded|payload|claims|token|credentials|creds|auth|keys|cfg)$/;
// Existing references include Namespace1.password and process.env.API_TOKEN123. Four consecutive digits are
// token-like; isolated/small numeric suffixes remain identifiers. Require complete camelCase/PascalCase words
// (readPassword, Namespace1), with at most a three-digit suffix, rather than a transition inside random bytes.
const dottedReference = (value: string): boolean => {
  if (/\d{4}/.test(value)) return false;
  const segments = value.split('.');
  return CODE_ROOT.test(segments[0]!) || segments.some(segment => /^(?:[a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)*)(?:\d{1,3})?$/.test(segment));
};
const COMPUTED_REFERENCE = /^[A-Za-z_$][\w$]*(?:(?:[ \t]*(?:\?\.|\.)[ \t]*[A-Za-z_$][\w$]*)|[ \t]*\([^()\r\n]*\)|[ \t]*\[[^\[\]\r\n]*\])+$/;
const PATH_REFERENCE = /^(?:~\/|\/)[\w./~-]*$/;
const CREDENTIAL_KEYS = String.raw`authorization|auth|api[_.-]?key|access[_.-]?key|account[_.-]?key|secret[_.-]?key|private[_.-]?key|(?:access|refresh|id)[_.-]?token|client[_.-]?secret|password|passwd|pwd|secret|token|credentials?|cookie|set[_.-]?cookie|aws[_.-]?access[_.-]?key[_.-]?id|aws[_.-]?secret[_.-]?access[_.-]?key|aws[_.-]?session[_.-]?token`;
const CREDENTIAL_KEY = new RegExp(String.raw`^(?:${CREDENTIAL_KEYS})$`, 'i');
const GENERIC_CREDENTIAL_KEY = /^(?:authorization|auth|pwd|secret|token|credentials?)$/i;
// Read the whole key wherever it occurs, then classify its terminal credential word at a segment boundary. The
// case-sensitive boundaries also cover camelCase, PascalCase and acronym prefixes without splitting the credential
// word itself (whose spelling is case-insensitive). Try the longest suffix first so clientSecret stays strong.
const credentialKey = (key: string): string | undefined => {
  for (const boundary of key.matchAll(/(?:^|[_.-]|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]))/g)) {
    const suffix = key.slice(boundary.index! + boundary[0].length);
    if (CREDENTIAL_KEY.test(suffix)) return suffix;
  }
  return undefined;
};
// A shell default (${PASSWORD:-default}) contains a colon, but its parameter name is not an assignment key.
const CREDENTIAL_ASSIGNMENT = /(?:^|[^\w.-])(?<!\$\{)([\w.-]+)["'`]?\s*(?:=>|[:=])\s*(?!\s)/dg;
const CLI_CREDENTIAL_ASSIGNMENT = /(?:^|[^\w.-])--([\w.-]+)(?:\s*=\s*(?!\s)|[ \t]+(?![ \t]))/dg;
// Cookie-specific suffixes remain supported; arbitrary trailing segments (token_count, auth_options) are not keys.
const COOKIE_ASSIGNMENT = new RegExp(String.raw`(?:^|[^\w.-])(?<!\$\{)(sessionid|session|sid|connect\.sid|PHPSESSID|JSESSIONID|_session|[\w.-]*(?:auth(?:entication)?|token)(?:[_.-]?(?:cookie|token|session))?)["'\x60]?\s*(?:=>|[:=])\s*` + ASSIGNMENT_VALUE, 'gi');
const NETRC_PASSWORD = new RegExp(String.raw`^(?:[ \t]*|[ \t]*machine[ \t][^\r\n]*?[ \t])(password)[ \t]+(?![ \t])` + ASSIGNMENT_VALUE + String.raw`[ \t]*\r?$`, 'gim');
const DOCKER_ENV_ASSIGNMENT = /^[ \t]*(?:ENV|ARG)[ \t]+([\w.-]+)[ \t]+(?![ \t])/dgm;
const ASSIGNMENT_LITERAL = new RegExp(ASSIGNMENT_VALUE, 'y');
const COOKIE_VALUE = new RegExp(String.raw`(?:^|;[ \t]*)([\w.-]+)\s*=\s*` + ASSIGNMENT_VALUE, 'g');
const CURL_COOKIE = new RegExp(String.raw`(?:^|\s)-b[ \t]*` + ASSIGNMENT_VALUE, 'g');
const literalCookie = (text: string): boolean => [...text.matchAll(COOKIE_VALUE)]
  .some(match => Boolean(literalRemainder(match[2] ?? match[3] ?? match[4] ?? match[5] ?? '')));

const literalAssignment = (text: string, pattern: RegExp, minLength = 1): boolean => {
  const assignments = new RegExp(pattern);
  const keyFirst = pattern === CREDENTIAL_ASSIGNMENT || pattern === CLI_CREDENTIAL_ASSIGNMENT || pattern === DOCKER_ENV_ASSIGNMENT;
  const values = new RegExp(ASSIGNMENT_LITERAL);
  let match: RegExpExecArray | null;
  while ((match = assignments.exec(text))) {
    const key = credentialKey(match[1]!);
    let captures: (string | undefined)[];
    if (keyFirst) {
      values.lastIndex = assignments.lastIndex;
      // A key cannot contain another assignment key. Resume at its end, preserving the boundary before a
      // nested assignment in an unrelated value, without first reading that value or retrying the key.
      assignments.lastIndex = match.indices![1]![1];
      if (!key) continue;
      const value = values.exec(text);
      if (!value) continue;
      assignments.lastIndex = values.lastIndex;
      captures = value.slice(1);
    } else captures = match.slice(2);
    // Credential keys own their thresholds; the broader cookie-name pattern must not bypass them.
    if (pattern === COOKIE_ASSIGNMENT && key && !/^(?:cookie|set[_.-]?cookie)$/i.test(key)) continue;
    const raw = (captures[0] ?? captures[1] ?? captures[2] ?? captures[3] ?? '').trim();
    // Header keys use the same spelling/quote parser as assignments. The cookie pair's value, rather than its
    // unfamiliar name or attributes, owns the placeholder decision; computed Cookie values contain no pair.
    if (pattern !== COOKIE_ASSIGNMENT && /^(?:cookie|set[_.-]?cookie)$/i.test(key ?? '')) {
      if (literalCookie(raw)) return true;
      continue;
    }
    const value = literalRemainder(raw);
    if (value.length < minLength) continue;
    // The header screen owns schemes, including their placeholder and concatenation rules.
    if (/^authorization$/i.test(key ?? '') && /^(?:bearer|basic|token)(?:\s|$)/i.test(raw)) continue;
    const quoted = captures[3] === undefined;
    const hasDigit = /\d/.test(value);
    const identifier = IDENTIFIER.test(value);
    const dotted = identifier && value.includes('.');
    const generic = pattern === COOKIE_ASSIGNMENT || GENERIC_CREDENTIAL_KEY.test(key ?? match[1]!);
    // Dots alone do not make a literal a reference. Strong keys permit alphabetic literals, excluding primitive
    // types; generic keys and session cookies still exclude digit-free names such as tokenValue.
    const reference = identifier && (dotted ? dottedReference(value) : (generic ? !hasDigit
      : /^(?:string|number|bigint|boolean|symbol|object|undefined|null|any|unknown|never|void)$/i.test(value)));
    // Plain dotted identifiers were decided above; the computed matcher also accepts member-only paths.
    if (!quoted && (reference || PATH_REFERENCE.test(raw) || (!IDENTIFIER.test(raw) && COMPUTED_REFERENCE.test(raw)))) continue;
    // Bare session cookies retain D1's eight-character threshold, excluding names even when quoted.
    if (pattern === COOKIE_ASSIGNMENT) { if (!reference) return true; continue; }
    // Strong keys accept any quoted literal, or an unquoted literal of at least eight characters. Generic keys
    // retain their value-shape thresholds, including quoted options such as credentials: 'include'.
    if (!generic && (quoted || value.length >= 8)) return true;
    // The 0.8.31 screen accepted quoted Authorization literals from twelve characters. Preserve that floor for
    // non-identifiers, while retaining the documented generic-key identifier exclusions.
    if (quoted && /^authorization$/i.test(key ?? '') && value.length >= 12 && !/\s/.test(raw)
      && (!IDENTIFIER.test(raw) || (dotted && !reference))) return true;
    if ((value.length >= 8 && hasDigit)
      || (value.length >= 16 && /^[A-Za-z0-9_%+./~:=@!-]+$/.test(value) && (!identifier || (dotted && !reference)))) return true;
  }
  return false;
};

// Keep the existing header punctuation/whitespace bounds; inspect whole operands after the scheme. A quoted
// concatenation operand is literal, an unquoted name/call is a reference, and later literal operands still count.
const AUTHORIZATION_SCHEME = /(?:^|[^\w.-])([\w.-]+)(?:[^\S\n]{0,64}[^\w\s]){0,8}[^\S\n]{0,64}(?:\n(?:[^\S\n]{0,64}[^\w\s]){0,8}[^\S\n]{0,64})?(?:bearer|basic|token)\s+/gi;
const HEADER_VALUE = new RegExp('^' + ASSIGNMENT_VALUE);
const HEADER_OPERAND_PART = new RegExp(TEMPLATE_VALUE + String.raw`|\([^()\r\n]*\)|\[[^\[\]\r\n]*\]|\+`, 'g');
const literalAuthorization = (text: string): boolean => {
  for (const match of text.matchAll(AUTHORIZATION_SCHEME)) {
    if (!/^authorization$/i.test(credentialKey(match[1]!) ?? '')) continue;
    let rest = text.slice(match.index! + match[0].length);
    let concatenation = /^["'`]\s*\+\s*/.exec(rest);
    let operand = Boolean(concatenation);
    if (concatenation) rest = rest.slice(concatenation[0].length);
    let value: RegExpExecArray | null;
    while ((value = HEADER_VALUE.exec(rest))) {
      const raw = value[1] ?? value[2] ?? value[3] ?? value[4] ?? '';
      const end = operand && value[4] !== undefined
        ? [...raw.matchAll(HEADER_OPERAND_PART)].find(part => part[0] === '+')?.index ?? raw.length : raw.length;
      const part = raw.slice(0, end);
      if (!(operand && value[4] !== undefined && (IDENTIFIER.test(part) || COMPUTED_REFERENCE.test(part))) && literalRemainder(part)) return true;
      rest = rest.slice(end < raw.length ? end : value[0].length);
      concatenation = /^(?:["'`])?\s*\+\s*/.exec(rest);
      if (!concatenation) break;
      operand = true;
      rest = rest.slice(concatenation[0].length);
    }
  }
  return false;
};
// URL passwords and Basic inputs use the same placeholder policy; a reference in one part cannot hide a literal
// password in another. Percent escapes remain literal, while whole printf slots (%s, %(pw)s) remain references.
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/?#@:"'`]{0,64}:([^\s/?#@"'`]{1,128})@/gi;
const BASIC_INPUT = /\b(?:btoa|Buffer\.from)\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`)/g;
// These formats establish that even a short value is a password/signature/base64 credential. SAS metadata stays
// outside the captured signature, and Docker's generic auth key is only special inside an auths object.
const CONNECTION_START = /(\bjdbc:)|(\b(?:Server|Data[ \t]+Source)=)|(\bSharedAccessSignature=)|(["'`]auths["'`]\s*:\s*\{)/gi;
const CONNECTION_VALUES = [
  { prefix: String.raw`[^\s"'\x60]*?[?&](?:password|pwd)=`, boundary: /[\s"'`]/g },
  { prefix: String.raw`[^"'\x60\r\n]*?;[ \t]*(?:Password|Pwd)=`, boundary: /["'`\r\n]/g },
  { prefix: String.raw`[^"'\x60\r\n]*?[&?]sig=`, boundary: /["'`\r\n]/g },
  { prefix: String.raw`[^}]*?["'\x60]auth["'\x60]\s*:\s*`, boundary: /}/g },
];
const WEBHOOK_URL = new RegExp(String.raw`\bhttps:\/\/(?:hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/|discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)(${TEMPLATE_VALUE}|[^\s/?#"'\x60]+)`, 'gi');
const literalPassword = (text: string): boolean => {
  for (const match of text.matchAll(URL_PASSWORD)) if (literalRemainder(match[1]!)) return true;
  const connections = new RegExp(CONNECTION_START);
  const values = CONNECTION_VALUES.map(({ prefix, boundary }) => ({
    value: new RegExp(prefix + ASSIGNMENT_VALUE, 'iy'), boundary: new RegExp(boundary), missingUntil: 0,
  }));
  let start: RegExpExecArray | null;
  while ((start = connections.exec(text))) {
    const candidate = values[start.slice(1).findIndex(part => part !== undefined)]!;
    if (start.index < candidate.missingUntil) continue;
    candidate.value.lastIndex = connections.lastIndex;
    const match = candidate.value.exec(text);
    if (!match) {
      // A failed prefix proved this whole region has no matching value. Later prefixes of the same format
      // cannot add one before its boundary; keep other formats searchable without scanning this region again.
      candidate.boundary.lastIndex = connections.lastIndex;
      candidate.missingUntil = candidate.boundary.exec(text)?.index ?? text.length;
      continue;
    }
    connections.lastIndex = candidate.value.lastIndex;
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    if (match[4] !== undefined && (COMPUTED_REFERENCE.test(raw) || PATH_REFERENCE.test(raw))) continue;
    if (literalRemainder(raw)) return true;
  }
  for (const match of text.matchAll(WEBHOOK_URL)) if (literalRemainder(match[1]!)) return true;
  for (const match of text.matchAll(CURL_COOKIE)) if (literalCookie(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')) return true;
  for (const match of text.matchAll(BASIC_INPUT)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const colon = [...value.matchAll(new RegExp(TEMPLATE_VALUE + '|:', 'g'))].find(part => part[0] === ':')?.index ?? -1;
    if (colon >= 0 && literalRemainder(value.slice(colon + 1))) return true;
  }
  return false;
};

export const looksSecret = (text: string): boolean => {
  const literal = shellLiterals(text);
  return SECRET_PATTERNS.some((re) => re.test(literal))
    || literalAuthorization(literal)
    || literalPassword(literal)
    || literalAssignment(literal, CREDENTIAL_ASSIGNMENT)
    || literalAssignment(literal, CLI_CREDENTIAL_ASSIGNMENT)
    || literalAssignment(literal, COOKIE_ASSIGNMENT, 8)
    || literalAssignment(literal, NETRC_PASSWORD)
    || literalAssignment(literal, DOCKER_ENV_ASSIGNMENT);
};

/**
 * The provider's limit is a TOKEN limit, and a byte cap is not proof of it. Calibrated against the live API on
 * 2026-09-21: coding-session content (`cat` output, JSON escaping, paths, punctuation) billed about 1.7 bytes per
 * token, so ASCII is charged at 1 token per 1.5 characters and every non-ASCII character at a whole token. Over-
 * counting wastes some budget; under-counting sends a request the provider refuses.
 */
export const estimateTokens = (text: string): number => {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 1.5) + wide;
};
