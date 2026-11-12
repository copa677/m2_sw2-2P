import { getCacheItem, setCacheItem } from '../storage/offlineDb';
import { syncQueueManager } from '../sync/syncQueueManager';
import { networkMonitor } from '../network/networkMonitor';

/**
 * Genera una clave determinista para caché según la URL y la consulta
 */
function buildCacheKey(url: string, query: string, variables: Record<string, any> = {}): string {
  const normQuery = query.replace(/\s+/g, ' ').trim();
  const varsStr = JSON.stringify(variables);
  return `gql_${url}_${normQuery}_${varsStr}`;
}

/**
 * Cliente HTTP para consumo de endpoints GraphQL con soporte nativo Offline-First
 * - Si es QUERY y no hay red: Devuelve el snapshot de caché local.
 * - Si es MUTATION y no hay red: Encola en outbox con clave de idempotencia y retorna respuesta optimista.
 */
export async function fetchGraphQL<T>(
  url: string,
  query: string,
  variables: Record<string, any> = {},
  token?: string,
  timeoutMs: number = 8000
): Promise<T> {
  const isMutation = query.trim().startsWith('mutation');
  const cacheKey = buildCacheKey(url, query, variables);
  const isOnline = networkMonitor.getOnlineSync();

  const customHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (token) {
    customHeaders['Authorization'] = `Bearer ${token}`;
  }

  // 1. Manejo preventivo si ya sabemos que estamos Offline
  if (!isOnline) {
    if (isMutation) {
      console.log('🔌 [fetchGraphQL] Modo Offline: Encolando mutación en outbox local...');
      await syncQueueManager.enqueue({
        endpoint: url,
        queryOrBody: query,
        variables,
        headers: customHeaders,
        operationType: 'GRAPHQL_MUTATION',
      });
      // Retornar payload simulado optimista
      return { _optimistic: true, _offline: true } as unknown as T;
    } else {
      console.log('🔌 [fetchGraphQL] Modo Offline: Recuperando snapshot de caché local...');
      const cached = await getCacheItem<T>(cacheKey, true);
      if (cached) return cached;
      throw new Error('Sin conexión a internet y no hay datos guardados localmente para esta pantalla.');
    }
  }

  // 2. Si estamos Online, intentar la petición normalmente
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: customHeaders,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Error HTTP ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors.map((e: any) => e.message).join(' | '));
    }

    const data = json.data as T;

    // Si fue una query exitosa, guardar snapshot en caché para uso offline futuro
    if (!isMutation && data) {
      setCacheItem(cacheKey, data).catch(() => {});
    }

    return data;
  } catch (err: any) {
    clearTimeout(timeoutId);

    // Fallo de red (timeout o corte repentino de señal)
    if (isMutation) {
      console.warn('⚠️ [fetchGraphQL] Falló llamada en vivo. Encolando mutación en outbox...');
      await syncQueueManager.enqueue({
        endpoint: url,
        queryOrBody: query,
        variables,
        headers: customHeaders,
        operationType: 'GRAPHQL_MUTATION',
      });
      return { _optimistic: true, _offline: true } as unknown as T;
    } else {
      try {
        const cached = await getCacheItem<T>(cacheKey, true);
        if (cached) return cached;
      } catch {
        // Ignorar fallo de lectura de caché
      }
      throw err;
    }
  }
}
