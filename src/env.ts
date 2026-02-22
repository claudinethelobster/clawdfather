export const env = {
  dbUrl: process.env.DATABASE_URL ?? 'postgresql://localhost/clawdfather',
  masterKey: process.env.CLAWDFATHER_MASTER_KEY ?? '',
  githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  webDomain: process.env.WEB_DOMAIN ?? 'localhost:3000',
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
