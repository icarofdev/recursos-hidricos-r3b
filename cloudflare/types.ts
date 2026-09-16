export type DeviceType = 'SM-WU' | 'SM-WA';

export interface Env {
 DB: D1Database;
 ASSETS?: Fetcher;
 APP_ENV?: string;
 APP_URL?: string;
 SESSION_SECRET?: string;
 PASSWORD_PEPPER?: string;
 BREVO_API_KEY?: string;
 BREVO_SENDER_EMAIL?: string;
 BREVO_SENDER_NAME?: string;
 MAIL_MODE?: string;
 MONITORIE_MODE?: string;
 MONITORIE_BASE_URL?: string;
 MONITORIE_CREDENTIALS?: string;
 MONITORIE_CACHE_SECONDS?: string;
 DEVICE_OFFLINE_AFTER_SECONDS?: string;
 INGEST_ENABLED?: string;
 DEVICE_TOKENS?: string;
 INITIAL_ADMIN_EMAIL?: string;
 ADMIN_BOOTSTRAP_KEY?: string;
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
}

export interface Session {
 token_hash: string;
 previous_hash: string | null;
 previous_until: number | null;
 user_id: number | null;
 session_version: number;
 csrf_token: string;
 remember: number;
 read_only: number;
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
}

export interface ReservoirRow {
 id: number;
 user_id: number;
 name: string;
 device_id: number;
 device_code: string;
 device_type: DeviceType;
 capacity_liters: number | null;
 linked_at: number;
 source: 'monitorie' | 'local' | 'mock';
 external_id: string | null;
 last_seen: number | null;
 reported_status: 'online' | 'offline';
}

export interface Reading {
 id: number;
 distancia: number;
 nivel: number;
 volume: number;
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
 status: 'online' | 'offline';
 last_seen: string | null;
 offline_after_seconds: number;
}

export interface Snapshot {
 device: DeviceStatus;
 data: Reading | SMWAReading | null;
 simulated?: boolean;
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
