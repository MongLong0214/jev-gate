// Shared synthetic key spellings and contexts for expectation and differential tests.
export const CREDENTIAL_WORDS = [
  ...['password', 'passwd', 'api_key', 'access_key', 'secret_key', 'private_key', 'client_secret',
    'access_token', 'refresh_token', 'id_token', 'aws_access_key_id', 'aws_secret_access_key', 'aws_session_token']
    .map(word => ({ word, strong: true })),
  ...['token', 'auth', 'authorization', 'secret', 'credential', 'credentials', 'pwd'].map(word => ({ word, strong: false })),
];
export const KEY_SPELLINGS = [
  { spelling: 'bare', key: (word: string) => word },
  { spelling: 'prefixed snake', key: (word: string) => `review_app_${word}` },
  { spelling: 'SCREAMING', key: (word: string) => `REVIEW_APP_${word.toUpperCase()}` },
  { spelling: 'kebab', key: (word: string) => `review-app-${word.replaceAll('_', '-')}` },
  { spelling: 'dot', key: (word: string) => `review.app.${word.replaceAll('_', '.')}` },
  { spelling: 'camelCase', key: (word: string) => 'reviewApp' + word.split('_').map(part => part[0]!.toUpperCase() + part.slice(1)).join('') },
  { spelling: 'PascalCase', key: (word: string) => 'ReviewApp' + word.split('_').map(part => part[0]!.toUpperCase() + part.slice(1)).join('') },
  { spelling: 'mixed case', key: (word: string) => 'rEvIeW_' + word.split('').map((ch, i) => i % 2 ? ch.toUpperCase() : ch).join('') },
];
export const ASSIGNMENT_CONTEXTS = [
  { context: 'quoted object compact', render: (key: string, value: string) => `{"${key}":${value}}` },
  { context: 'quoted object spaced', render: (key: string, value: string) => `{ "${key}" \t : \t ${value} }` },
  { context: 'YAML', render: (key: string, value: string) => `${key}: ${value}` },
  { context: 'env', render: (key: string, value: string) => `${key}=${value}` },
  { context: 'export', render: (key: string, value: string) => `export ${key}=${value}` },
  { context: 'header', render: (key: string, value: string) => `X-${key}: ${value}` },
  { context: 'query first', render: (key: string, value: string) => `https://example.test/?${key}=${value}&page=1` },
  { context: 'query later', render: (key: string, value: string) => `https://example.test/?page=1&${key}=${value}` },
  { context: 'TOML', render: (key: string, value: string) => `${key} = ${value}` },
  { context: 'kwargs', render: (key: string, value: string) => `connect(${key}=${value})` },
  { context: 'object literal', render: (key: string, value: string) => `{ ${key}: ${value} }` },
  { context: 'CLI space', render: (key: string, value: string) => `client --${key} ${value}` },
  { context: 'CLI equals', render: (key: string, value: string) => `client --${key}=${value}` },
  { context: 'CLI at start', render: (key: string, value: string) => `--${key} ${value} --verbose` },
  { context: 'prose start', render: (key: string, value: string) => `${key}: ${value}; then continue.` },
  { context: 'prose middle', render: (key: string, value: string) => `Observed ${key}=${value}; continue.` },
  { context: 'prose end', render: (key: string, value: string) => `Observed ${key}: ${value}` },
  { context: 'inline quoted JSON', render: (key: string, value: string) => `Observed {"${key}":${value}} during review.` },
  { context: 'quoted prose assignment', render: (key: string, value: string) => `note='Observed ${key}=${value} during review.'` },
];

