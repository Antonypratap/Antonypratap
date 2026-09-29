-- Least-privilege PostgreSQL role for the running Veyra API (docs/SECURITY.md, "Database security").
--
-- Two roles:
--   veyra_owner  owns the schema; used ONLY by `npm run db:migrate` (DATABASE_MIGRATION_URL).
--   veyra_app    the running API (DATABASE_URL): reads and writes rows, nothing else.
--
-- Create them once, as an administrator (choose the passwords in your secret store):
--   CREATE ROLE veyra_owner LOGIN PASSWORD '…';
--   CREATE ROLE veyra_app LOGIN PASSWORD '…';
--   CREATE DATABASE veyra OWNER veyra_owner;
--   REVOKE ALL ON DATABASE veyra FROM PUBLIC;
--   GRANT CONNECT ON DATABASE veyra TO veyra_app;
--
-- Then run THIS file as veyra_owner, connected to the veyra database, after every db:migrate
-- (new tables need their grants):
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f apps/api/sql/runtime-role.sql

-- Nobody but the owner creates objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO veyra_app;

-- Rows only: no DELETE, TRUNCATE, DDL or ownership. The production API never deletes rows.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO veyra_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM veyra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO veyra_app;

-- The workflow audit trail and the security audit trail are append-only for the application.
REVOKE UPDATE ON audit_events, security_events FROM veyra_app;

-- The API reads which migrations are applied (it refuses to start with pending ones).
GRANT USAGE ON SCHEMA drizzle TO veyra_app;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO veyra_app;
