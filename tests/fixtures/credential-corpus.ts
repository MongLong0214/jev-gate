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

// CLI operands establish the credential meaning even for short literals. Every syntax has a reference twin.
export const CLI_CREDENTIAL_CORPUS = [
  { tool: 'docker', label: '#295 global value', render: (value: string) => `docker --context production --config ./config login -u review -p ${value}` },
  { tool: 'docker', label: '#295 global equals', render: (value: string) => `docker --context=production login -p ${value}` },
  { tool: 'helm', label: '#295 global value', render: (value: string) => `helm --kube-context production -n review repo add review https://example.test --password ${value}` },
  { tool: 'kubectl', label: '#295 global value', render: (value: string) => `kubectl --context production --token ${value} get pods` },
  { tool: 'git', label: '#295 global value', render: (value: string) => `git -C ./review -c http.extraHeader=Authorization:\\ Basic\\ ${value} status` },
  { tool: 'mysql', label: '#295 global value', render: (value: string) => `mysql --defaults-file ./config -p${value}` },
  { tool: 'aws', label: '#295 global value', render: (value: string) => `aws --profile review configure set aws_secret_access_key ${value}` },
  ...['\\\n', '\\\r\n'].map(newline => ({ tool: 'curl', label: '#295 continuation', render: (value: string) => `curl ${newline}  -u reviewer:${value} https://example.test` })),
  ...['-sSu ', '-sSu', '-fsSLu ', '-sSU '].map(flag => ({ tool: 'curl', label: '#295 cluster ' + flag, render: (value: string) => `curl ${flag}reviewer:${value} https://example.test` })),

  { tool: 'curl', label: 'M1 -u quoted', value: 'synthetic-canary-123', render: (value: string) => `curl -u 'reviewer:${value}' https://example.test` },
  { tool: 'curl', label: 'M1 --user quoted', value: 'synthetic-canary-123', render: (value: string) => `curl --user 'reviewer:${value}' https://example.test` },
  ...['-u ', '-u', '--user ', '--user=', '--proxy-user ', '--proxy-user=', '-U ', '-U'].map(flag => ({
    tool: 'curl', label: flag.trim(), render: (value: string) => `curl ${flag}user:${value} https://example.test`,
  })),
  ...['--password=', '--http-password=', '--ftp-password=', '--user=review --password='].map(flag => ({
    tool: 'wget', label: flag, render: (value: string) => `wget ${flag}${value} https://example.test`,
  })),
  ...['mysql', 'mariadb'].flatMap(tool => ['-p', '--password='].map(flag => ({
    tool, label: flag, render: (value: string) => `${tool} ${flag}${value}`,
  }))),
  ...['PGPASSWORD', 'MYSQL_PWD'].map(tool => ({ tool, label: 'assignment', render: (value: string) => `${tool}=${value} client` })),
  ...['-a ', '--pass '].map(flag => ({ tool: 'redis-cli', label: flag.trim(), render: (value: string) => `redis-cli ${flag}${value} PING` })),
  ...['mongosh', 'mongo'].flatMap(tool => ['-p ', '--password '].map(flag => ({
    tool, label: flag.trim(), render: (value: string) => `${tool} ${flag}${value}`,
  }))),
  { tool: 'sshpass', label: '-p', render: (value: string) => `sshpass -p ${value} ssh host` },
  ...['-p ', '--password '].map(flag => ({ tool: 'docker', label: flag.trim(), render: (value: string) => `docker login -u review ${flag}${value}` })),
  { tool: 'docker', label: 'tool-name username', render: (value: string) => `docker login -u mysql -p ${value}` },
  { tool: 'htpasswd', label: 'tool-name username', render: (value: string) => `htpasswd -b ./fixture mysql ${value}` },
  { tool: 'helm', label: 'repo add --password', render: (value: string) => `helm repo add review https://example.test --password ${value}` },
  { tool: 'kubectl', label: '--token=', render: (value: string) => `kubectl --token=${value} get pods` },
  { tool: 'htpasswd', label: '-b', render: (value: string) => `htpasswd -b ./fixture review ${value}` },
  { tool: 'az', label: 'login -p', render: (value: string) => `az login -u review -p ${value}` },
  { tool: 'aws', label: 'configure set', render: (value: string) => `aws configure set aws_secret_access_key ${value}` },
  { tool: 'npm', label: 'config set', render: (value: string) => `npm config set //registry.example.test/:_authToken ${value}` },
  // The ordinary quoted header is already detected; shell-escaped spaces exercise the CLI operand path too.
  { tool: 'git', label: '-c quoted Basic', render: (value: string) => `git -c http.extraHeader="Authorization: Basic ${value}" status` },
  { tool: 'git', label: '-c escaped Basic', render: (value: string) => `git -c http.extraHeader=Authorization:\\ Basic\\ ${value} status` },
  ...['-passin pass:', '-passout pass:', '-k '].map(flag => ({
    tool: 'openssl', label: flag.trim(), render: (value: string) => `openssl enc ${flag}${value}`,
  })),
  { tool: 'zip', label: '-P', render: (value: string) => `zip -P ${value} archive.zip file` },
  { tool: '7z', label: '-p', render: (value: string) => `7z a -p${value} archive.7z file` },
  { tool: 'ssh-keygen', label: '-N', render: (value: string) => `ssh-keygen -N ${value} -f ./fixture` },
].map(row => ({ value: 'p7', ...row }));
export const CLI_CREDENTIAL_CASES = CLI_CREDENTIAL_CORPUS.flatMap(row => [
  { ...row, variant: 'literal', text: row.render(row.value), secret: true },
  { ...row, variant: 'reference', text: row.render('${PASS}'), secret: false },
]);
export const CLI_CREDENTIAL_NEGATIVES = [
  'curl -u "$USER:$PASS" https://x', 'curl -u user: https://x', 'curl -u "${CREDS}" https://x',
  'docker login --password-stdin', 'client --password-file ./pw.txt',
  'docker --context production run -p 8080:80', 'helm --kube-context production list',
  'curl -sS -- -u user:p7', 'curl -o resultu user:p7',
  'docker run -p 8080:80', 'ssh -p 2222 host', 'python -m http.server -p 8000', 'mkdir -p dir',
  'git log -p', 'npm run dev -- -p 3000', 'mysql -p', 'use curl -u with a token',
  'client -a p7 -k p7 -N p7 -P p7 -u user:p7 -p p7',
  'curl https://x; client -u user:p7', 'mysql --version\nclient -pp7',
  'docker run --password-file ./pw.txt', 'openssl enc -passin file:./pw.txt',
  'openssl enc -passin env:PASS', 'openssl enc -passout stdin',
  'curl -- -u user:p7', 'zip -- -P p7',
];
