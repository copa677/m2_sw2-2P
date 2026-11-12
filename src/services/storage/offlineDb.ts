import * as SQLite from 'expo-sqlite';

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export interface OutboxItem {
  id: string;
  endpoint: string;
  query_or_body: string;
  variables_json: string;
  headers_json: string;
  idempotency_key: string;
  operation_type: 'GRAPHQL_MUTATION' | 'REST_POST' | 'REST_PUT';
  estado: 'PENDING' | 'SYNCING' | 'COMPLETED' | 'FAILED';
  intentos: number;
  created_at: number;
  last_error?: string | null;
}

export interface CacheItem<T = any> {
  cache_key: string;
  data: T;
  updated_at: number;
  ttl_ms: number;
}

/**
 * Inicialización atómica y segura de la base de datos SQLite para operaciones offline
 */
export async function getOfflineDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const db = await SQLite.openDatabaseAsync('apex_offline.db');

      // Inicializar tablas de forma segura
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS outbox_queue (
          id TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL,
          query_or_body TEXT NOT NULL,
          variables_json TEXT NOT NULL DEFAULT '{}',
          headers_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT NOT NULL UNIQUE,
          operation_type TEXT NOT NULL DEFAULT 'GRAPHQL_MUTATION',
          estado TEXT NOT NULL DEFAULT 'PENDING',
          intentos INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS cache_store (
          cache_key TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          ttl_ms INTEGER NOT NULL DEFAULT 86400000
        );

        CREATE INDEX IF NOT EXISTS idx_outbox_estado ON outbox_queue(estado, created_at);
      `);

      dbInstance = db;
      return db;
    } catch (err: any) {
      console.warn('⚠️ [offlineDb] Error abriendo base de datos SQLite:', err?.message || err);
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Encola una mutación en el outbox
 */
export async function enqueueOutbox(item: Omit<OutboxItem, 'estado' | 'intentos'>): Promise<void> {
  try {
    const db = await getOfflineDb();
    await db.runAsync(
      `INSERT OR REPLACE INTO outbox_queue 
        (id, endpoint, query_or_body, variables_json, headers_json, idempotency_key, operation_type, estado, intentos, created_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL)`,
      [
        item.id,
        item.endpoint,
        item.query_or_body,
        item.variables_json,
        item.headers_json,
        item.idempotency_key,
        item.operation_type,
        item.created_at,
      ]
    );
  } catch (err: any) {
    console.warn('[offlineDb] Error encolando acción en outbox:', err?.message);
  }
}

/**
 * Obtiene las mutaciones pendientes en orden cronológico (FIFO)
 */
export async function getPendingOutboxItems(limit: number = 20): Promise<OutboxItem[]> {
  try {
    const db = await getOfflineDb();
    const rows = await db.getAllAsync<OutboxItem>(
      `SELECT * FROM outbox_queue 
       WHERE estado = 'PENDING' OR (estado = 'FAILED' AND intentos < 5)
       ORDER BY created_at ASC 
       LIMIT ?`,
      [limit]
    );
    return rows || [];
  } catch (err: any) {
    console.warn('[offlineDb] Error obteniendo pendientes de outbox:', err?.message);
    return [];
  }
}

/**
 * Conteo seguro de elementos pendientes en la cola
 */
export async function getPendingCount(): Promise<number> {
  try {
    const db = await getOfflineDb();
    const result = await db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM outbox_queue WHERE estado IN ('PENDING', 'SYNCING')`
    );
    return result?.count ?? 0;
  } catch (err: any) {
    return 0;
  }
}

/**
 * Actualiza el estado de un ítem en la cola
 */
export async function updateOutboxStatus(
  id: string,
  estado: 'PENDING' | 'SYNCING' | 'COMPLETED' | 'FAILED',
  errorMsg?: string
): Promise<void> {
  try {
    const db = await getOfflineDb();
    if (estado === 'COMPLETED') {
      await db.runAsync(`DELETE FROM outbox_queue WHERE id = ?`, [id]);
    } else if (estado === 'FAILED') {
      await db.runAsync(
        `UPDATE outbox_queue SET estado = ?, intentos = intentos + 1, last_error = ? WHERE id = ?`,
        [estado, errorMsg ?? 'Error desconocido', id]
      );
    } else {
      await db.runAsync(`UPDATE outbox_queue SET estado = ? WHERE id = ?`, [estado, id]);
    }
  } catch (err: any) {
    console.warn('[offlineDb] Error actualizando estado de outbox:', err?.message);
  }
}

/**
 * Guarda un snapshot de respuesta en cache_store
 */
export async function setCacheItem<T>(key: string, data: T, ttlMs: number = 86400000): Promise<void> {
  try {
    const db = await getOfflineDb();
    const now = Date.now();
    await db.runAsync(
      `INSERT OR REPLACE INTO cache_store (cache_key, data_json, updated_at, ttl_ms) VALUES (?, ?, ?, ?)`,
      [key, JSON.stringify(data), now, ttlMs]
    );
  } catch (err) {
    console.warn(`[offlineDb] Error guardando caché para key ${key}`);
  }
}

/**
 * Recupera un snapshot de cache_store con fallback seguro
 */
export async function getCacheItem<T>(key: string, ignoreTtl = true): Promise<T | null> {
  try {
    const db = await getOfflineDb();
    const row = await db.getFirstAsync<{ data_json: string; updated_at: number; ttl_ms: number }>(
      `SELECT data_json, updated_at, ttl_ms FROM cache_store WHERE cache_key = ?`,
      [key]
    );
    if (!row) return null;

    if (!ignoreTtl) {
      const now = Date.now();
      if (now - row.updated_at > row.ttl_ms) {
        return null;
      }
    }

    return JSON.parse(row.data_json) as T;
  } catch (err) {
    return null;
  }
}
