import { useState, useEffect } from 'react';
import { networkMonitor } from '../services/network/networkMonitor';
import { getPendingCount } from '../services/storage/offlineDb';
import { syncQueueManager } from '../services/sync/syncQueueManager';

export interface NetworkStatus {
  isOnline: boolean;
  pendingCount: number;
  isSyncing: boolean;
}

export function useNetworkStatus(): NetworkStatus {
  const [isOnline, setIsOnline] = useState<boolean>(networkMonitor.getOnlineSync());
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [isSyncing, setIsSyncing] = useState<boolean>(syncQueueManager.isSyncInProgress());

  useEffect(() => {
    // 1. Suscribirse a cambios de red
    const unsubscribeNet = networkMonitor.subscribe((online) => {
      setIsOnline(online);
      refreshPending();
    });

    // 2. Suscribirse a eventos de sincronización
    const unsubscribeSync = syncQueueManager.subscribe((syncing, count) => {
      setIsSyncing(syncing);
      setPendingCount(count);
    });

    const refreshPending = async () => {
      try {
        const count = await getPendingCount();
        setPendingCount(count);
      } catch {
        // Ignorar
      }
    };

    refreshPending();

    return () => {
      unsubscribeNet();
      unsubscribeSync();
    };
  }, []);

  return {
    isOnline,
    pendingCount,
    isSyncing,
  };
}

