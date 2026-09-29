/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** Supabase project URL (https://<project-ref>.supabase.co). */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase publishable (anon) key — safe to expose in the browser. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
