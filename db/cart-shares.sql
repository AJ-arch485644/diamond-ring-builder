-- Additive dormant feature. Apply deliberately to the intended Supabase project.
-- No foreign keys or writes to diamonds, orders, tokens, inventory or existing state.
BEGIN;
CREATE TABLE IF NOT EXISTS public.cart_shares (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536 AND payload->>'version' = '1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS cart_shares_expiry ON public.cart_shares(expires_at);
CREATE TABLE IF NOT EXISTS public.cart_share_rate_limits (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.cart_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_share_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cart_shares, public.cart_share_rate_limits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.cart_shares TO service_role;
CREATE OR REPLACE FUNCTION public.cart_share_consume_rate(p_key text, p_limit integer, p_window_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_count integer;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_RATE_ARGUMENTS';
  END IF;
  INSERT INTO public.cart_share_rate_limits(key, count, expires_at)
  VALUES (p_key, 1, clock_timestamp() + make_interval(secs => p_window_seconds))
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN public.cart_share_rate_limits.expires_at <= clock_timestamp() THEN 1 ELSE LEAST(public.cart_share_rate_limits.count + 1, p_limit + 1) END,
    expires_at = CASE WHEN public.cart_share_rate_limits.expires_at <= clock_timestamp() THEN clock_timestamp() + make_interval(secs => p_window_seconds) ELSE public.cart_share_rate_limits.expires_at END
  RETURNING count INTO current_count;
  RETURN current_count <= p_limit;
END;
$$;
CREATE OR REPLACE FUNCTION public.cart_share_cleanup(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'INVALID_CLEANUP_LIMIT'; END IF;
  DELETE FROM public.cart_shares WHERE token_hash IN (SELECT token_hash FROM public.cart_shares WHERE expires_at < clock_timestamp() - interval '1 day' ORDER BY expires_at LIMIT p_limit);
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM public.cart_share_rate_limits WHERE key IN (SELECT key FROM public.cart_share_rate_limits WHERE expires_at < clock_timestamp() - interval '1 day' ORDER BY expires_at LIMIT p_limit);
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.cart_share_consume_rate(text, integer, integer), public.cart_share_cleanup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cart_share_consume_rate(text, integer, integer), public.cart_share_cleanup(integer) TO service_role;
COMMIT;
