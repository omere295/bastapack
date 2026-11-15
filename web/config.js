// Public settings for the app. These are safe to publish: the publishable key only allows what the
// database's row-level security allows, and every table requires a staff login.
export const SUPABASE_URL = "https://hpfxgqsgshglaiwrtogb.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable__n_orvLOfVYnyaN4EGfzMQ_nwdWsKRK";

// Usernames staff type on the login screen → Supabase Auth accounts.
export const LOGINS = {
  admin: "admin@bastadagim.co.il",
  basta: "staff@bastadagim.co.il",
  staff: "staff@bastadagim.co.il",
};

// How often other devices' changes are picked up (milliseconds).
export const REFRESH_MS = 8000;
