// Simple connection controller - handles when to connect/disconnect WebSocket
// This is the ONLY place that decides when WebSocket should connect

import webSocketManager from './WebSocketManager';

class ConnectionController {
  constructor() {
    this.isOnline = navigator.onLine;
    this.hasUser = false;
    this.token = null;
    
    // Debouncing for preventing multiple rapid calls
    this.lastEvaluationTime = 0;
    this.evaluationDebounce = 200; // 200ms minimum between evaluations
    this.forceNextEvaluation = false; // Flag to bypass debouncing
    
    // Set up browser online/offline detection
    this.setupBrowserEvents();
    
    console.log('🎮 ConnectionController initialized');
  }

  // Update user state
  setUser(user, token) {
    const hadUser = this.hasUser;
    this.hasUser = !!user;
    this.token = token;
    
    console.log(`👤 User state changed: ${hadUser} → ${this.hasUser}`);
    
    if (this.hasUser && this.token) {
      // Force immediate evaluation on user authentication
      this.forceNextEvaluation = true;
      this.evaluateConnection();
    } else {
      this.disconnect('no user');
    }
  }

  // Update online state
  setOnline(online, reason = '') {
    const wasOnline = this.isOnline;
    this.isOnline = online;
    
    console.log(`🌐 Online state changed: ${wasOnline} → ${online} (${reason})`);
    
    if (online) {
      this.evaluateConnection();
    } else {
      this.disconnect('offline');
    }
  }

  // Main logic: decide if WebSocket should be connected
  evaluateConnection() {
    // Debounce rapid calls (unless forced)
    const now = Date.now();
    if (!this.forceNextEvaluation && now - this.lastEvaluationTime < this.evaluationDebounce) {
      console.log(`🚫 Connection evaluation debounced (${now - this.lastEvaluationTime}ms since last)`);
      return;
    }
    this.lastEvaluationTime = now;
    this.forceNextEvaluation = false; // Reset force flag
    
    const shouldConnect = this.isOnline && this.hasUser && this.token;
    const currentState = webSocketManager.getState();
    
    console.log(`🤔 Connection evaluation:`, {
      shouldConnect,
      isOnline: this.isOnline,
      hasUser: this.hasUser,
      hasToken: !!this.token,
      currentState: currentState.state
    });

    if (shouldConnect) {
      if (currentState.state === 'disconnected') {
        console.log('✅ Conditions met, connecting WebSocket...');
        this.connect();
      } else {
        console.log('🔗 WebSocket already connecting/connected');
      }
    } else {
      if (currentState.state !== 'disconnected') {
        console.log('❌ Conditions not met, disconnecting WebSocket...');
        this.disconnect('conditions not met');
      }
    }
  }

  // Connect WebSocket
  async connect() {
    if (!this.token) {
      console.error('❌ Cannot connect - no token');
      return;
    }

    try {
      await webSocketManager.connect(this.token);
      console.log('✅ WebSocket connected via ConnectionController');
    } catch (error) {
      console.error('❌ WebSocket connection failed:', error);
      
      // Retry logic could go here if needed
      setTimeout(() => {
        if (this.isOnline && this.hasUser && this.token) {
          console.log('🔄 Retrying WebSocket connection...');
          this.connect();
        }
      }, 5000);
    }
  }

  // Disconnect WebSocket
  disconnect(reason) {
    console.log(`🔌 Disconnecting WebSocket: ${reason}`);
    webSocketManager.disconnect();
  }

  // Handle app resume/visibility changes
  onAppResume() {
    console.log('📱 App resumed, evaluating connection...');
    
    // Check if we're still online
    this.setOnline(navigator.onLine, 'app resume');
    
    // Re-evaluate connection
    this.evaluateConnection();
  }

  // Handle app going to background
  onAppPause() {
    console.log('😴 App paused');
    // Don't disconnect - let natural WebSocket timeout handle it
  }

  // Set up browser online/offline events
  setupBrowserEvents() {
    window.addEventListener('online', () => {
      this.setOnline(true, 'browser online event');
    });

    window.addEventListener('offline', () => {
      this.setOnline(false, 'browser offline event');
    });

    // Visibility change for mobile resume detection
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.onAppResume();
      } else {
        this.onAppPause();
      }
    });

    // Window focus for additional resume detection
    window.addEventListener('focus', () => {
      this.onAppResume();
    });
  }

  // Get current state for debugging
  getState() {
    return {
      isOnline: this.isOnline,
      hasUser: this.hasUser,
      hasToken: !!this.token,
      webSocket: webSocketManager.getState()
    };
  }
}

// Create singleton
const connectionController = new ConnectionController();

export default connectionController;