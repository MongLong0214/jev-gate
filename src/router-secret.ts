/**
 * The credential screen, copied from `src/outbound-text.ts` because a Function Hooks module cannot import from the
 * Node side of the repository. `tests/router/secret-parity.test.ts` fails when the two lists drift.
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
  /\bnpm_[A-Za-z0-9]{36,}\b/,
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // A bearer token outside a header line, whatever its prefix. The digit keeps "bearer" in prose from matching.
  /\b[Bb]earer\s+(?=[A-Za-z0-9_\-.~+/]*\d)[A-Za-z0-9_\-.~+/]{16,}/,
];

// Capture references and their literal neighbours together, including complete call/member/subscript suffixes.
// Recognising one token is never grounds for discarding the rest of a value.
const TEMPLATE_VALUE = String.raw`\$\{\{[^{}\r\n]*\}\}|\$\{[^{}\r\n]*\}|\{\{[^{}\r\n]*\}\}|\{[^{}\r\n]*\}|<[^<>\r\n]*>`;
const BARE_VALUE = String.raw`(?:${TEMPLATE_VALUE}|\$(?!\{)|[A-Za-z0-9_%+./~:=@!?*-]|[ \t]*(?:\([^()\r\n]*\)|\[[^\[\]\r\n]*\])|[ \t]+(?:\?\.|\.)[ \t]*[A-Za-z_$][\w$]*)+`;
const ASSIGNMENT_VALUE = String.raw`(?:"([^"\r\n]*)"|'([^'\r\n]*)'|\x60([^\x60\r\n]*)\x60|(${BARE_VALUE}))`;

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
const CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`(?:^|[^\w.-])(?<!\$\{)([\w.-]+)["'\x60]?\s*(?:=>|[:=])\s*` + ASSIGNMENT_VALUE, 'g');
const CLI_CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`(?:^|[^\w.-])--([\w.-]+)(?:\s*=\s*|[ \t]+)` + ASSIGNMENT_VALUE, 'g');
// Cookie-specific suffixes remain supported; arbitrary trailing segments (token_count, auth_options) are not keys.
const COOKIE_ASSIGNMENT = new RegExp(String.raw`(?:^|[^\w.-])(?<!\$\{)(sessionid|session|sid|connect\.sid|PHPSESSID|JSESSIONID|_session|[\w.-]*(?:auth(?:entication)?|token)(?:[_.-]?(?:cookie|token|session))?)["'\x60]?\s*(?:=>|[:=])\s*` + ASSIGNMENT_VALUE, 'gi');
const NETRC_PASSWORD = new RegExp(String.raw`^(?:[ \t]*|[ \t]*machine[ \t]+[^\r\n]*?[ \t]+)(password)[ \t]+` + ASSIGNMENT_VALUE + String.raw`[ \t]*\r?$`, 'gim');
const DOCKER_ENV_ASSIGNMENT = new RegExp(String.raw`^[ \t]*(?:ENV|ARG)[ \t]+([\w.-]+)[ \t]+` + ASSIGNMENT_VALUE, 'gm');
const COOKIE_VALUE = new RegExp(String.raw`(?:^|;[ \t]*)([\w.-]+)\s*=\s*` + ASSIGNMENT_VALUE, 'g');
const CURL_COOKIE = new RegExp(String.raw`(?:^|\s)-b[ \t]*` + ASSIGNMENT_VALUE, 'g');
const literalCookie = (text: string): boolean => [...text.matchAll(COOKIE_VALUE)]
  .some(match => Boolean(literalRemainder(match[2] ?? match[3] ?? match[4] ?? match[5] ?? '')));

const literalAssignment = (text: string, pattern: RegExp, minLength = 1): boolean => {
  const assignments = new RegExp(pattern);
  let match: RegExpExecArray | null;
  while ((match = assignments.exec(text))) {
    const key = credentialKey(match[1]!);
    if ((pattern === CREDENTIAL_ASSIGNMENT || pattern === CLI_CREDENTIAL_ASSIGNMENT || pattern === DOCKER_ENV_ASSIGNMENT) && !key) {
      // An unrelated key's quoted value may itself contain a credential assignment. Do not skip its contents.
      assignments.lastIndex = match.index + 1;
      continue;
    }
    // Credential keys own their thresholds; the broader cookie-name pattern must not bypass them.
    if (pattern === COOKIE_ASSIGNMENT && key && !/^(?:cookie|set[_.-]?cookie)$/i.test(key)) continue;
    const raw = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
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
    const quoted = match[5] === undefined;
    const hasDigit = /\d/.test(value);
    const identifier = IDENTIFIER.test(value);
    const generic = pattern === COOKIE_ASSIGNMENT || GENERIC_CREDENTIAL_KEY.test(key ?? match[1]!);
    // Dotted paths always name another value. Strong keys permit alphabetic literals, excluding primitive/type
    // names; generic keys and session cookies still exclude digit-free identifiers such as tokenValue.
    const reference = identifier && (value.includes('.') || (generic ? !hasDigit
      : /^(?:string|number|bigint|boolean|symbol|object|undefined|null|any|unknown|never|void)$/i.test(value)));
    if (!quoted && (reference || PATH_REFERENCE.test(raw) || COMPUTED_REFERENCE.test(raw))) continue;
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
const CONNECTION_VALUE = new RegExp(String.raw`(?:\bjdbc:[^\s"'\x60]*?[?&](?:password|pwd)=|\b(?:Server|Data[ \t]+Source)=[^"'\x60\r\n]*?;[ \t]*(?:Password|Pwd)=|\bSharedAccessSignature=[^"'\x60\r\n]*?[&?]sig=|["'\x60]auths["'\x60]\s*:\s*\{[^}]*?["'\x60]auth["'\x60]\s*:\s*)` + ASSIGNMENT_VALUE, 'gi');
const WEBHOOK_URL = new RegExp(String.raw`\bhttps:\/\/(?:hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/|discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)(${TEMPLATE_VALUE}|[^\s/?#"'\x60]+)`, 'gi');
const literalPassword = (text: string): boolean => {
  for (const match of text.matchAll(URL_PASSWORD)) if (literalRemainder(match[1]!)) return true;
  for (const match of text.matchAll(CONNECTION_VALUE)) {
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
