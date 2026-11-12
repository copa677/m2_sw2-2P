import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

type NetworkListener = (isOnline: boolean, state: NetInfoState) => void;

class NetworkMonitor {
  private static instance: NetworkMonitor;
  private isConnected: boolean = true;
  private isInternetReachable: boolean | null = true;
  private listeners: Set<NetworkListener> = new Set();
  private unsubscribeNetInfo: (() => void) | null = null;

  private constructor() {
    this.init();
  }

  public static getInstance(): NetworkMonitor {
    if (!NetworkMonitor.instance) {
      NetworkMonitor.instance = new NetworkMonitor();
    }
    return NetworkMonitor.instance;
  }

  private init() {
    this.unsubscribeNetInfo = NetInfo.addEventListener((state: NetInfoState) => {
      const online = Boolean(state.isConnected && (state.isInternetReachable ?? true));
      const changed = this.isConnected !== online;
      this.isConnected = online;
      this.isInternetReachable = state.isInternetReachable;

      if (changed) {
        console.log(`📡 [NetworkMonitor] Estado de red cambiado: ${online ? 'ONLINE' : 'OFFLINE'}`);
        this.notifyListeners(online, state);
      }
    });

    // Estado inicial
    NetInfo.fetch().then((state) => {
      this.isConnected = Boolean(state.isConnected && (state.isInternetReachable ?? true));
      this.isInternetReachable = state.isInternetReachable;
    });
  }

  private notifyListeners(isOnline: boolean, state: NetInfoState) {
    this.listeners.forEach((listener) => {
      try {
        listener(isOnline, state);
      } catch (err) {
        console.error('[NetworkMonitor] Error en listener:', err);
      }
    });
  }

  public async checkOnline(): Promise<boolean> {
    const state = await NetInfo.fetch();
    this.isConnected = Boolean(state.isConnected && (state.isInternetReachable ?? true));
    return this.isConnected;
  }

  public getOnlineSync(): boolean {
    return this.isConnected;
  }

  public subscribe(listener: NetworkListener): () => void {
    this.listeners.add(listener);
    // Notificar de inmediato el estado actual
    NetInfo.fetch().then((state) => listener(this.isConnected, state));

    return () => {
      this.listeners.delete(listener);
    };
  }

  public destroy() {
    if (this.unsubscribeNetInfo) {
      this.unsubscribeNetInfo();
      this.unsubscribeNetInfo = null;
    }
    this.listeners.clear();
  }
}

export const networkMonitor = NetworkMonitor.getInstance();

