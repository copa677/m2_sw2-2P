import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { Colors, Spacing, Radius } from '../../constants/theme';

export const OfflineSyncBanner: React.FC = () => {
  const { isOnline, pendingCount, isSyncing } = useNetworkStatus();
  const [showSyncedSuccess, setShowSyncedSuccess] = useState(false);
  const [prevPending, setPrevPending] = useState(0);

  // Detectar transición de sincronización finalizada con éxito
  useEffect(() => {
    if (prevPending > 0 && pendingCount === 0 && isOnline && !isSyncing) {
      setShowSyncedSuccess(true);
      const timer = setTimeout(() => {
        setShowSyncedSuccess(false);
      }, 3500);
      return () => clearTimeout(timer);
    }
    setPrevPending(pendingCount);
  }, [pendingCount, isOnline, isSyncing]);

  if (isOnline && pendingCount === 0 && !isSyncing && !showSyncedSuccess) {
    return null;
  }

  // Estado 1: Todo sincronizado con éxito (temporal)
  if (showSyncedSuccess) {
    return (
      <View style={[styles.container, styles.successContainer]}>
        <Ionicons name="checkmark-circle" size={16} color="#FFFFFF" style={styles.icon} />
        <Text style={styles.textSuccess}>¡Sincronización completada! Todos tus datos están al día.</Text>
      </View>
    );
  }

  // Estado 2: Conexión recuperada y sincronizando datos en segundo plano
  if (isSyncing || (isOnline && pendingCount > 0)) {
    return (
      <View style={[styles.container, styles.syncingContainer]}>
        <Ionicons name="sync-outline" size={16} color="#FFFFFF" style={styles.icon} />
        <Text style={styles.textSyncing}>
          Sincronizando {pendingCount} {pendingCount === 1 ? 'cambio pendiente' : 'cambios pendientes'} con el servidor...
        </Text>
      </View>
    );
  }

  // Estado 3: Sin conexión a internet (Modo Offline)
  return (
    <View style={[styles.container, styles.offlineContainer]}>
      <Ionicons name="cloud-offline-outline" size={16} color="#FFFFFF" style={styles.icon} />
      <Text style={styles.textOffline}>
        Modo sin conexión.{' '}
        {pendingCount > 0
          ? `${pendingCount} ${pendingCount === 1 ? 'acción guardada localmente.' : 'acciones guardadas localmente.'}`
          : 'Tus acciones se guardarán de forma segura en tu teléfono.'}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: Spacing.md,
    zIndex: 9999,
  },
  offlineContainer: {
    backgroundColor: '#D97706', // Ámbar cálido de advertencia elegante
  },
  syncingContainer: {
    backgroundColor: '#0D9488', // Teal de actividad técnica
  },
  successContainer: {
    backgroundColor: Colors.accentSage, // Verde salvia del sistema
  },
  icon: {
    marginRight: 8,
  },
  textOffline: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  textSyncing: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  textSuccess: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
});

