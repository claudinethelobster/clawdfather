-- Migration: PR #5 → PR #6 (feat/session-first-mobile-v2)
-- Run this if upgrading from the feat/mobile-auth-overhaul schema
-- to the feat/session-first-mobile-v2 schema.
--
-- This migration is SAFE to run on an existing PR #5 database.
-- It adds missing columns/constraints and creates new tables
-- without dropping any existing data.

-- 1. Extend accounts table with new columns
ALTER TABLE accounts 
  ADD COLUMN IF NOT EXISTS github_id TEXT,
  ADD COLUMN IF NOT EXISTS login TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Populate login from existing data
UPDATE accounts SET login = display_name WHERE login IS NULL AND display_name IS NOT NULL;
UPDATE accounts SET login = split_part(email, '@', 1) WHERE login IS NULL AND email IS NOT NULL;
UPDATE accounts SET login = id::text WHERE login IS NULL;

-- Make display_name nullable (GitHub users may not have one)
ALTER TABLE accounts ALTER COLUMN display_name DROP NOT NULL;

-- Populate github_id from oauth_identities if it exists
UPDATE accounts a 
  SET github_id = o.provider_user_id
  FROM oauth_identities o 
  WHERE o.account_id = a.id AND o.provider = 'github' AND a.github_id IS NULL;

-- Add unique constraint on github_id (required for ON CONFLICT in auth.ts)
ALTER TABLE accounts ADD CONSTRAINT IF NOT EXISTS accounts_github_id_key UNIQUE (github_id);

-- 2. Create auth_sessions (new name for app_sessions with extra columns)
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  ip_address TEXT,
  user_agent TEXT
);

-- Migrate sessions from app_sessions if it exists
INSERT INTO auth_sessions (id, account_id, token_hash, created_at, expires_at, last_used_at)
  SELECT id, account_id, token_hash, created_at, 
         COALESCE(expires_at, NOW() + INTERVAL '30 days'),
         last_used_at
  FROM app_sessions
  WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'app_sessions')
  ON CONFLICT (token_hash) DO NOTHING;

-- 3. Ensure oauth_state_cache has code_verifier column
ALTER TABLE oauth_state_cache
  ADD COLUMN IF NOT EXISTS code_verifier TEXT;

-- 4. Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
