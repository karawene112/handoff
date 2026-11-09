// Public settings for the website. These two values are safe to publish:
// the database's access rules decide what each signed-in person can see.
window.HANDOFF_CONFIG = {
  supabaseUrl: "https://ctnetlnnticvwkvxmmws.supabase.co",
  supabaseKey: "sb_publishable_a6be_qFtmfm_ErcFyvpnJA_RJQefGnC",
  // Set to true after turning on Google sign-in in Supabase (Authentication > Providers > Google).
  googleSignIn: false,
  // Sign people out after this many minutes without using the site.
  idleMinutes: 30,
};
