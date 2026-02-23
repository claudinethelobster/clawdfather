#!/usr/bin/env bash
set -e
cd /Users/claudine/.openclaw/workspace/clawdfather

PROMPT="Fix the OAuth callback UX bug in src/routes/auth.ts and src/auth-middleware.ts.

TASK 1 — src/routes/auth.ts handleOAuthGitHubCallback:
Currently ends with: apiOk(res, { token, account, expires_at, ... })
Replace that entire final apiOk call with this logic:

  const wantsJson =
    (req.headers['accept'] ?? '').includes('application/json') ||
    url.searchParams.get('mode') === 'json';

  if (wantsJson) {
    apiOk(res, { token, account: { id: acct.id, display_name: acct.display_name, email: acct.email }, expires_at: expiresAt.toISOString() });
  } else {
    // Set session cookie
    const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    const isSecure = req.headers['x-forwarded-proto'] === 'https' || (!config.webDomain.startsWith('localhost') && !config.webDomain.startsWith('127.'));
    const secureFlag = isSecure ? '; Secure' : '';
    res.setHeader('Set-Cookie', \`session_token=\${token}; HttpOnly\${secureFlag}; SameSite=Lax; Path=/; Max-Age=\${maxAge}\`);
    // Redirect to app
    const baseUrl = config.webDomain.startsWith('localhost') || config.webDomain.startsWith('127.')
      ? \`http://\${config.webDomain.includes(':') ? config.webDomain : \`\${config.webDomain}:\${config.webPort ?? 3000}\`}/\`
      : \`https://\${config.webDomain}/\`;
    res.setHeader('Location', baseUrl);
    res.writeHead(302);
    res.end();
  }

Note: url is already parsed at the top of handleOAuthGitHubCallback as:
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host}\`);
So you can use url.searchParams.get('mode') directly.

TASK 2 — src/auth-middleware.ts authenticate:
After extracting the token from Bearer header, also support session_token cookie as fallback.
Change the function so it:
1. Tries Authorization: Bearer header first (existing)
2. If no Bearer header, tries Cookie header: parse 'session_token' value from it
3. If neither found, return 401

Here is the new logic structure:
  let token: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else {
    // Try cookie
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('session_token='));
    if (match) token = match.slice('session_token='.length);
  }
  if (!token) {
    apiError(res, 401, 'unauthorized', 'Missing or invalid auth token.');
    return null;
  }
  const tokenH = hashToken(token);
  // ... rest of existing DB query and logic unchanged ...

TASK 3 — Add tests in src/routes/auth.test.ts:
Use node:test and node:assert. Since we can't easily spin up a real DB, write unit tests that:
1. Test the cookie/redirect detection logic in isolation (you can extract a helper or just test the URL parsing logic)
2. Test the cookie parsing logic from the middleware (extract as a testable helper or inline test)
3. Write integration-style tests using mock req/res objects to verify:
   - Default flow (no Accept: application/json) -> produces a Set-Cookie header and 302 redirect
   - JSON mode (Accept: application/json) -> no redirect, JSON body
   - mode=json query param -> JSON body
   - Cookie auth fallback in authenticate()

For mocking DB in tests, use module-level variable patching. The tests should run with ts-node.

TASK 4 — package.json:
Add to devDependencies: 'ts-node' (run: npm install --save-dev ts-node)
Add script: 'test': 'node --require ts-node/register --test src/routes/auth.test.ts'

TASK 5 — Build and verify:
Run: npm run build
Fix any TypeScript errors.

TASK 6 — Commit and push:
git add -A
git commit -m 'fix: OAuth callback redirects to app with session cookie instead of returning raw JSON

- handleOAuthGitHubCallback: detect wantsJson via Accept header or ?mode=json
- Default browser flow: set HttpOnly session_token cookie + 302 redirect to app root
- authenticate(): add cookie fallback for session_token alongside Bearer token
- Add auth.test.ts with tests for redirect, cookie, and JSON mode behavior
- Preserve full API compatibility: Bearer + JSON mode unchanged'
git push origin feat/mobile-auth-overhaul"

agent --yolo --print "$PROMPT" 2>&1
