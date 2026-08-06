-- ---------------------------------------------------------------------------
-- One-time database bootstrap. Run as a superuser (postgres), connected to
-- the `ros` database:
--
--   createdb -U postgres ros
--   psql -U postgres -d ros -f scripts/bootstrap.sql
--
-- Creates the two roles the isolation model depends on, then hands ownership
-- of the schema to ros_owner so that migrations never need superuser again.
--
-- CHANGE THE PASSWORDS before running this anywhere but a local machine, and
-- keep them in sync with .env.
-- ---------------------------------------------------------------------------

-- ros_owner: owns every table, runs DDL and migrations. As the table owner it
-- is exempt from row-level security, which is exactly why the application
-- must never connect as this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ros_owner') THEN
    CREATE ROLE ros_owner LOGIN PASSWORD 'change_me_owner';
  END IF;
END
$$;

-- ros_app: the runtime role. Owns nothing, creates nothing, and is subject to
-- every policy. This is what DATABASE_URL points at.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ros_app') THEN
    CREATE ROLE ros_app LOGIN PASSWORD 'change_me_app';
  END IF;
END
$$;

-- Neither role should ever acquire these.
ALTER ROLE ros_owner NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE ros_app   NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

ALTER SCHEMA public OWNER TO ros_owner;

-- ros_owner must be able to create schemas in this database, not merely own
-- the public one. Drizzle's migrator keeps its journal in a separate `drizzle`
-- schema and creates it on first run, so without this every migration fails at
-- the first statement with "permission denied for database".
--
-- `createdb -U postgres ros` leaves postgres as the database owner, which is
-- why this grant is needed rather than being implied by schema ownership.
-- Granted dynamically so the database may be named something other than `ros`.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO ros_owner', current_database());
END
$$;

-- ros_app may use the schema but not create in it, so a compromised
-- application cannot introduce an unprotected table to stage data in.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM ros_app;
GRANT USAGE ON SCHEMA public TO ros_app;

-- Tables created by future migrations are granted to ros_app automatically.
-- Without this, every new table would be invisible to the app until someone
-- remembered to grant it by hand.
ALTER DEFAULT PRIVILEGES FOR ROLE ros_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app;

ALTER DEFAULT PRIVILEGES FOR ROLE ros_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ros_app;

-- Catch up anything that already exists, so re-running this file is safe.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ros_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ros_app;

-- Note: no GRANT of TRUNCATE or REFERENCES, and no DDL rights. Combined with
-- the policies in the migrations, ros_app's entire reach is parameterised
-- DML on rows its tenant context permits.
