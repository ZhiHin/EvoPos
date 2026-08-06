-- ---------------------------------------------------------------------------
-- One-time database bootstrap. Run as a superuser (postgres), connected to
-- the `evopos` database:
--
--   createdb -U postgres evopos
--   psql -U postgres -d evopos -f scripts/bootstrap.sql
--
-- Creates the two roles the isolation model depends on, then hands ownership
-- of the schema to evoadmin so that migrations never need superuser again.
--
-- CHANGE THE PASSWORDS before running this anywhere but a local machine, and
-- keep them in sync with .env.
-- ---------------------------------------------------------------------------

-- evoadmin: owns every table, runs DDL and migrations. As the table owner it
-- is exempt from row-level security, which is exactly why the application
-- must never connect as this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evoadmin') THEN
    CREATE ROLE evoadmin LOGIN PASSWORD 'change_me_admin';
  END IF;
END
$$;

-- evoapp: the runtime role. Owns nothing, creates nothing, and is subject to
-- every policy. This is what DATABASE_URL points at.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evoapp') THEN
    CREATE ROLE evoapp LOGIN PASSWORD 'change_me_app';
  END IF;
END
$$;

-- Neither role should ever acquire these.
ALTER ROLE evoadmin NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE evoapp   NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

ALTER SCHEMA public OWNER TO evoadmin;

-- evoadmin must be able to create schemas in this database, not merely own
-- the public one. Drizzle's migrator keeps its journal in a separate `drizzle`
-- schema and creates it on first run, so without this every migration fails at
-- the first statement with "permission denied for database".
--
-- `createdb -U postgres evopos` leaves postgres as the database owner, which is
-- why this grant is needed rather than being implied by schema ownership.
-- Granted dynamically so the database may be named something other than
-- `evopos`.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO evoadmin', current_database());
END
$$;

-- evoapp may use the schema but not create in it, so a compromised
-- application cannot introduce an unprotected table to stage data in.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM evoapp;
GRANT USAGE ON SCHEMA public TO evoapp;

-- Tables created by future migrations are granted to evoapp automatically.
-- Without this, every new table would be invisible to the app until someone
-- remembered to grant it by hand.
ALTER DEFAULT PRIVILEGES FOR ROLE evoadmin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO evoapp;

ALTER DEFAULT PRIVILEGES FOR ROLE evoadmin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO evoapp;

-- Catch up anything that already exists, so re-running this file is safe.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO evoapp;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO evoapp;

-- Note: no GRANT of TRUNCATE or REFERENCES, and no DDL rights. Combined with
-- the policies in the migrations, evoapp's entire reach is parameterised
-- DML on rows its tenant context permits.
