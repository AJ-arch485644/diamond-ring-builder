const { createClient } = require('@supabase/supabase-js');

// For API routes (public, read-only)
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// For sync script (full access, write)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = { supabasePublic, supabaseAdmin };
