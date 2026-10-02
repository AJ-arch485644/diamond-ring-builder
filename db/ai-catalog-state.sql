-- Additive, isolated storage for the background Catalog metadata worker.
-- Run deliberately in the intended Supabase project; this is not auto-applied.
-- It does not modify diamonds, orders, Shopify tokens, or existing application tables.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_catalog_state (
  key text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_catalog_leases (
  shop text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.ai_catalog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_catalog_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_catalog_state, public.ai_catalog_leases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ai_catalog_state TO service_role;

-- Pre-write snapshots and audit events can only be appended, never replaced.
CREATE OR REPLACE FUNCTION public.ai_catalog_protect_audit()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.key LIKE '%.myshopify.com:audit:%' THEN RAISE EXCEPTION 'AI_CATALOG_AUDIT_IMMUTABLE'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ai_catalog_audit_immutable ON public.ai_catalog_state;
CREATE TRIGGER ai_catalog_audit_immutable BEFORE UPDATE OR DELETE ON public.ai_catalog_state
FOR EACH ROW EXECUTE FUNCTION public.ai_catalog_protect_audit();
REVOKE ALL ON FUNCTION public.ai_catalog_protect_audit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ai_catalog_acquire_lease(p_shop text, p_owner text, p_ttl_seconds integer DEFAULT 180)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  IF p_shop IS NULL OR p_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' OR p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'INVALID_LEASE_ARGUMENTS';
  END IF;
  INSERT INTO public.ai_catalog_leases(shop, owner, expires_at)
  VALUES (p_shop, p_owner, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (shop) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
  WHERE public.ai_catalog_leases.expires_at <= clock_timestamp() OR public.ai_catalog_leases.owner = EXCLUDED.owner;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_catalog_renew_lease(p_shop text, p_owner text, p_ttl_seconds integer DEFAULT 180)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'INVALID_LEASE_ARGUMENTS'; END IF;
  UPDATE public.ai_catalog_leases SET expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds)
  WHERE shop = p_shop AND owner = p_owner AND expires_at > clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_catalog_release_lease(p_shop text, p_owner text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  DELETE FROM public.ai_catalog_leases WHERE shop = p_shop AND owner = p_owner;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

-- The lease row lock fences every private write against lease takeover. Checking
-- ownership in application code alone would leave a check/write race.
CREATE OR REPLACE FUNCTION public.ai_catalog_write_state(p_shop text, p_owner text, p_key text, p_payload jsonb, p_insert_only boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE held public.ai_catalog_leases%ROWTYPE;
BEGIN
  IF p_shop IS NULL OR p_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' OR p_owner IS NULL OR p_key IS NULL
     OR left(p_key, length(p_shop) + 1) <> p_shop || ':' OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_insert_only IS NULL THEN RAISE EXCEPTION 'INVALID_STATE_ARGUMENTS'; END IF;
  SELECT * INTO held FROM public.ai_catalog_leases WHERE shop = p_shop FOR UPDATE;
  IF NOT FOUND OR held.owner <> p_owner OR held.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'AI_CATALOG_LEASE_LOST'; END IF;
  IF p_key LIKE '%.myshopify.com:audit:%' AND NOT p_insert_only THEN RAISE EXCEPTION 'AI_CATALOG_AUDIT_IMMUTABLE'; END IF;
  IF p_insert_only THEN
    INSERT INTO public.ai_catalog_state(key, payload, updated_at) VALUES (p_key, p_payload, clock_timestamp());
  ELSE
    INSERT INTO public.ai_catalog_state(key, payload, updated_at) VALUES (p_key, p_payload, clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_catalog_acquire_lease(text, text, integer), public.ai_catalog_renew_lease(text, text, integer), public.ai_catalog_release_lease(text, text), public.ai_catalog_write_state(text, text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_catalog_acquire_lease(text, text, integer), public.ai_catalog_renew_lease(text, text, integer), public.ai_catalog_release_lease(text, text), public.ai_catalog_write_state(text, text, text, jsonb, boolean) TO service_role;
COMMIT;
