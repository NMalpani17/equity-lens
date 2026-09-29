/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** Supabase project URL (https://<project-ref>.supabase.co). */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase publishable (anon) key — safe to expose in the browser. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** Email of the shared demo account used by the "Try demo" button. */
  readonly VITE_DEMO_EMAIL?: string;
  /** Password of the shared demo account used by the "Try demo" button. */
  readonly VITE_DEMO_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
