export type DeviceType = 'SM-WU' | 'SM-WA';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_ENV?: string;
  APP_URL?: string;
  SESSION_SECRET?: string;
  PASSWORD_PEPPER?: string;
  PASSWORD_PEPPER_ID?: string;
  PASSWORD_PEPPER_PREVIOUS?: string;
  PASSWORD_PEPPER_PREVIOUS_ID?: string;
  PASSWORD_PEPPER_PREVIOUS_UNTIL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  MAIL_MODE?: string;
  MAIL_REQUIRED?: string;
  TOTP_ENCRYPTION_KEY?: string;
  TOTP_KEY_ID?: string;
  TOTP_ENCRYPTION_KEY_PREVIOUS?: string;
  TOTP_KEY_PREVIOUS_ID?: string;
  TOTP_KEY_PREVIOUS_UNTIL?: string;
  MONITORIE_MODE?: string;
  MONITORIE_JWT?: string;
  MONITORIE_USERNAME?: string;
  MONITORIE_PASSWORD?: string;
  MONITORIE_SMWU_MAPPING?: string;
  MONITORIE_SMWA_MAPPING?: string;
  MONITORIE_CACHE_SECONDS?: string;
  DEVICE_OFFLINE_AFTER_SECONDS?: string;
  INGEST_ENABLED?: string;
  CORS_ORIGINS?: string;
  READINGS_RETENTION_DAYS?: string;
  AUDIT_RETENTION_DAYS?: string;
  RETENTION_BATCH_SIZE?: string;
  RETENTION_MAX_BATCHES?: string;
  HISTORY_MAX_SAMPLES?: string;
  OBSERVABILITY_SAMPLE_RATE?: string;
  SECURITY_EVENT_FAILURE_SAMPLE_RATE?: string;
  INGEST_DEVICE_LIMIT?: string;
  METRICS?: AnalyticsEngineDataset;
  DASHBOARD_SHARE_USERNAME?: string;
  DASHBOARD_SHARE_PASSWORD?: string;
  DASHBOARD_SHARE_USER_EMAIL?: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  session_version: number;
  password_hash: string;
  role: 'admin' | 'user';
  email_verified_at: number | null;
}

export interface Session {
  token_hash: string;
  previous_hash: string | null;
  previous_until: number | null;
  pending_hash: string | null;
  pending_until: number | null;
  share_version: string | null;
  user_id: number | null;
  session_version: number;
  csrf_token: string;
  remember: number;
  read_only: number;
  admin_mfa_at: number | null;
  created_at: number;
  last_seen: number;
  rotated_at: number;
  expires_at: number;
}

export interface Context {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  session: Session | null;
  user: User | null;
  cookies: string[];
  requestId: string;
}

export interface ReservoirRow {
  id: number;
  user_id: number;
  name: string;
  device_id: number;
  device_code: string;
  device_type: DeviceType;
  capacity_liters: number | null;
  installation_type: string;
  geometry: string;
  measurement_config: string | null;
  configuration_version: number;
  access_linked_at: number;
  access_linked_at_ms: number;
  linked_at_ms: number;
  owner_linked_at: number;
  access_user_id: number;
  access_generation: string;
  ownership_generation: number;
  user_count: number;
  linked_at: number;
  updated_at: number;
  source: 'monitorie' | 'local' | 'mock';
  external_id: string | null;
  mac_address: string | null;
  last_seen: number | null;
  reported_status: 'online' | 'offline';
  communication_checked_at: number | null;
}

export interface Reading {
  id: number;
  distancia: number;
  nivel: number | null;
  volume: number | null;
  measurement_quality?: string;
  rssi_wifi: number;
  timestamp: string;
}

export interface SMWAReading {
  id: number;
  vazao: number;
  consumo_acumulado: number;
  volume: number | null;
  rssi_wifi: number;
  timestamp: string;
}

export interface DeviceStatus {
  id: number;
  code?: string;
  type: DeviceType;
  status: 'online' | 'offline' | 'unknown';
  last_seen: string | null;
  offline_after_seconds: number;
  telemetry_linked?: boolean;
  communication_checked_at?: string | null;
  cache_fetched_at?: string | null;
  cache_age_seconds?: number;
  data_stale?: boolean;
  integration_status?: 'ok' | 'busy' | 'unavailable';
}

export interface Snapshot {
  device: DeviceStatus;
  data: Reading | SMWAReading | null;
  simulated?: boolean;
  units?: TelemetryUnits;
}

export interface ActivationCodeRow {
  id: number;
  device_id: number;
  code_hash: string;
  created_by_user_id: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  revoked_by_user_id: number | null;
  created_at: number;
}

export interface AuditLogRow {
  id: number;
  action: string;
  device_id: number | null;
  user_id: number | null;
  details: string | null;
  ip: string | null;
  created_at: number;
}

export type TelemetryUnits = Partial<
  Record<'distancia' | 'nivel' | 'volume' | 'rssi_wifi' | 'vazao' | 'consumo_acumulado', string | null>
>;
