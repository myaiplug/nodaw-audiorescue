export interface Env {
  AUDIO: R2Bucket;
  CASES: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  OPS_PASSWORD: string;
  DISCORD_WEBHOOK_URL?: string;
  PUBLIC_BASE_URL: string;
}
