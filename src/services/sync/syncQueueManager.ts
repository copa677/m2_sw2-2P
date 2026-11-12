import * as Crypto from 'expo-crypto';
import {
  enqueueOutbox,
  getPendingOutboxItems,
  updateOutboxStatus,
  getPendingCount,
  OutboxItem,
} from '../storage/offlineDb';
import { networkMonitor } from '../network/networkMonitor';

type SyncListener = (isSyncing: boolean, pendingCount: number) => void;

class SyncQueueManager {
  private static instance: SyncQueueManager;
  private syncing: boolean = false;
  private listeners: Set<SyncListener> = new Set();

  private constructor() {
    this.init();
  }

  public static getInstance(): SyncQueueManager {
    if (!SyncQueueManager.instance) {
      SyncQueueManager.instance = new SyncQueueManager();
    }
    return SyncQueueManager.instance;
  }

  private init() {
    // Escuchar cambios de red con retardo para permitir que el hardware y el bridge inicialicen
    networkMonitor.subscribe((isOnline) => {
      if (isOnline) {
        setTimeout(() => {
          this.processQueue().catch(() => {});
        }, 1000);
      }
    });
  }

  public isSyncInProgress(): boolean {
    return this.syncing;
  }

  public subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    getPendingCount().then((cnt) => listener(this.syncing, cnt));
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async notifyListeners() {
    const cnt = await getPendingCount();
    this.listeners.forEach((l) => l(this.syncing, cnt));
  }

  /**
   * Encola una mutación en el outbox con clave de idempotencia única
   */
  public async enqueue(params: {
    endpoint: string;
    queryOrBody: string;
    variables?: Record<string, any>;
    headers?: Record<string, string>;
    operationType?: 'GRAPHQL_MUTATION' | 'REST_POST' | 'REST_PUT';
  }): Promise<string> {
    const id = Crypto.randomUUID();
    const idempotencyKey = `idemp_${id}`;

    await enqueueOutbox({
      id,
      endpoint: params.endpoint,
      query_or_body: params.queryOrBody,
      variables_json: JSON.stringify(params.variables || {}),
      headers_json: JSON.stringify(params.headers || {}),
      idempotency_key: idempotencyKey,
      operation_type: params.operationType || 'GRAPHQL_MUTATION',
      created_at: Date.now(),
    });

    console.log(`📦 [SyncQueueManager] Acción encolada localmente: ${id} (key: ${idempotencyKey})`);
    this.notifyListeners();

    // Si hay red ahora mismo, intentar procesar inmediatamente
    if (networkMonitor.getOnlineSync()) {
      this.processQueue();
    }

    return id;
  }

  /**
   * Procesa la cola de acciones pendientes en orden cronológico (FIFO)
   */
  public async processQueue(): Promise<void> {
    if (this.syncing) return;
    if (!networkMonitor.getOnlineSync()) return;

    this.syncing = true;
    await this.notifyListeners();

    try {
      const pendingItems = await getPendingOutboxItems(10);
      if (pendingItems.length === 0) {
        this.syncing = false;
        await this.notifyListeners();
        return;
      }

      console.log(`🚀 [SyncQueueManager] Sincronizando ${pendingItems.length} acciones pendientes...`);

      for (const item of pendingItems) {
        // Verificar si seguimos online antes de cada despacho
        if (!networkMonitor.getOnlineSync()) break;

        await updateOutboxStatus(item.id, 'SYNCING');
        const success = await this.dispatchItem(item);

        if (success) {
          console.log(`✅ [SyncQueueManager] Acción sincronizada con éxito: ${item.id}`);
          await updateOutboxStatus(item.id, 'COMPLETED');
        } else {
          console.warn(`⚠️ [SyncQueueManager] Falló la sincronización de la acción: ${item.id}`);
          await updateOutboxStatus(item.id, 'FAILED', 'Fallo de red durante el envío');
        }
      }
    } catch (err: any) {
      console.warn('[SyncQueueManager] En espera de base de datos para outbox:', err?.message || err);
    } finally {
      this.syncing = false;
      await this.notifyListeners();

      // Si aún quedan elementos pendientes y hay red, continuar siguiente lote
      const remaining = await getPendingCount();
      if (remaining > 0 && networkMonitor.getOnlineSync()) {
        setTimeout(() => this.processQueue(), 1500);
      }
    }
  }

  /**
   * Ejecuta físicamente la llamada HTTP hacia el servidor con la clave de idempotencia
   */
  private async dispatchItem(item: OutboxItem): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const customHeaders: Record<string, string> = JSON.parse(item.headers_json || '{}');
      const variables: Record<string, any> = JSON.parse(item.variables_json || '{}');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Idempotency-Key': item.idempotency_key,
        ...customHeaders,
      };

      let bodyStr = '';
      if (item.operation_type === 'GRAPHQL_MUTATION') {
        bodyStr = JSON.stringify({
          query: item.query_or_body,
          variables,
        });
      } else {
        bodyStr = item.query_or_body;
      }

      const res = await fetch(item.endpoint, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        // Códigos 4xx terminales (excepto 429) no deben reintentarse infinitamente
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          console.error(`[SyncQueueManager] Error terminal del servidor ${res.status}: ${res.statusText}`);
          return true; // Se marca completado para descartarlo y no trabar la cola
        }
        return false;
      }

      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        console.warn(`[SyncQueueManager] Advertencias GraphQL:`, json.errors);
      }

      return true;
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.warn(`[SyncQueueManager] Error en despacho de red para ${item.id}:`, err?.message);
      return false;
    }
  }
}

export const syncQueueManager = SyncQueueManager.getInstance();

