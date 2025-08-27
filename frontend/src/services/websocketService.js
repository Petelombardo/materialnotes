// services/websocketService.js
import { io } from 'socket.io-client';

class WebSocketService {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 8; // Increased for mobile
    this.eventHandlers = new Map();
    this.isMobile = this.detectMobile();
    this.connectionQuality = 'unknown';
    this.lastPingTime = null;
    this.reconnectTimer = null;
    this.serverConnectionId = null; // Store server's custom connectionId
    
    // Expose WebSocket service globally for API integration
    if (typeof window !== 'undefined') {
      window.websocketService = this;
    }
  }

  // Schedule reconnection with backoff
  scheduleReconnection() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    const baseDelay = this.isMobile ? 5000 : 2000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), 30000);
    
    console.log(`🔄 Scheduling reconnection in ${delay/1000}s (attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimer = setTimeout(() => {
      if (!this.connected && this.socket) {
        console.log('🔄 Attempting scheduled reconnection...');
        this.socket.connect();
      }
    }, delay);
  }

  // Get connection status for UI
  getConnectionStatus() {
    return {
      connected: this.connected,
      quality: this.connectionQuality,
      isMobile: this.isMobile,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  // Enhanced connection check
  isConnected() {
    return this.connected && this.socket && this.socket.connected;
  }

  detectMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
  }

  // Enhanced disconnect with cleanup
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.socket) {
      console.log('🔌 Disconnecting WebSocket');
      this.socket.removeAllListeners(); // Clean up all listeners
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
      this.serverConnectionId = null; // Clear server connectionId on disconnect
    }
    
    // Always reset connection flag on disconnect
    this._isConnecting = false;
  }

  // Manual reconnection method
  async forceReconnect(token) {
    console.log('🔄 Force reconnecting WebSocket...');
    this.disconnect();
    
    // Add delay for mobile devices
    const delay = this.isMobile ? 2000 : 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    return this.connect(token);
  }

  async connect(token) {
    // CRITICAL: Prevent multiple simultaneous connection attempts at service level
    if (this._isConnecting) {
      console.log('🔒 WebSocket connection already in progress, waiting for existing attempt');
      return new Promise((resolve, reject) => {
        const checkConnection = () => {
          if (this.connected && this.socket) {
            resolve();
          } else if (!this._isConnecting) {
            reject(new Error('Connection attempt failed'));
          } else {
            setTimeout(checkConnection, 100);
          }
        };
        checkConnection();
      });
    }
    
    this._isConnecting = true;
    
    try {
      if (this.socket) {
        console.log('🔌 Disconnecting existing WebSocket connection');
        this.socket.removeAllListeners(); // CRITICAL: Remove all listeners to prevent cascading events
        this.socket.disconnect();
        this.socket = null;
      }
      // Determine the WebSocket URL based on current location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      const port = window.location.port;
      
      // Construct the Socket.IO URL
      let socketUrl;
      if (port && port !== '80' && port !== '443') {
        socketUrl = `${protocol}//${host}:${port}`;
      } else {
        socketUrl = `${protocol}//${host}`;
      }

      console.log('🔌 Attempting WebSocket connection to:', socketUrl);

      this.socket = io(socketUrl, {
        auth: {
          token: token
        },
        // Improved configuration for stability
        transports: ['websocket', 'polling'],
        upgrade: true,
        rememberUpgrade: true, // Remember successful upgrades for better performance
        timeout: 20000, // Longer timeout to reduce connection failures
        autoConnect: true,
        
        // Conservative reconnection settings for stability
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 3000,
        reconnectionDelayMax: 15000,
        randomizationFactor: 0.3, // Less randomization for more predictable behavior
        
        // Stability-focused options
        forceNew: false, // Allow connection reuse for better stability
        multiplex: true, // Enable multiplexing for efficiency
        
        // Stable ping/pong settings
        pingTimeout: 180000, // 3 minutes - generous for stability
        pingInterval: 45000 // 45 seconds - reasonable frequency
      });

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._isConnecting = false; // Unlock connection on timeout
          reject(new Error('WebSocket connection timeout'));
        }, 25000); // Generous timeout for all devices to improve stability

        this.socket.on('connect', () => {
          clearTimeout(timeout);
          console.log('✅ WebSocket connected successfully');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.lastPingTime = Date.now();
          this.connectionQuality = 'good';
          this._isConnecting = false; // Unlock connection
          
          // Sync with API service connectivity
          if (typeof window !== 'undefined' && window.apiService) {
            window.apiService.setOnlineStatus(true, 'websocket');
          }
          
          this.emit('connection-restored');
          resolve();
        });

        this.socket.on('connect_error', (error) => {
          clearTimeout(timeout);
          console.error('❌ WebSocket connection error:', error.message || error);
          this.connected = false;
          this.connectionQuality = 'poor';
          this._isConnecting = false; // Unlock connection on error
          this.emit('connection-failed');
          reject(error);
        });

        this.socket.on('disconnect', (reason) => {
          console.log('🔌 WebSocket disconnected:', reason);
          this.connected = false;
          this.connectionQuality = reason === 'transport close' ? 'poor' : 'unknown';
          this.emit('connection-lost');
          
          // More stable reconnection logic - let Socket.IO handle most reconnections automatically
          if (reason === 'io server disconnect') {
            // Server intentionally disconnected, wait longer before reconnecting
            console.log('🔄 Server disconnected, waiting before reconnection...');
            setTimeout(() => {
              if (!this.connected && this.socket) {
                console.log('🔄 Attempting scheduled reconnection after server disconnect...');
                this.socket.connect();
              }
            }, 5000); // Wait 5 seconds for server disconnect
          } else if (reason === 'transport close' || reason === 'transport error') {
            // Network issues - let Socket.IO handle automatic reconnection
            console.log('🔄 Network issue detected, relying on automatic reconnection...');
            // Don't manually trigger reconnection - let Socket.IO's built-in logic handle it
          }
        });

        this.socket.on('reconnect', (attemptNumber) => {
          console.log('🔌 WebSocket reconnected after', attemptNumber, 'attempts');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.connectionQuality = 'good';
          this.emit('connection-restored');
        });

        this.socket.on('reconnect_error', (error) => {
          this.reconnectAttempts++;
          console.error('❌ WebSocket reconnection error:', error.message || error, 'attempt:', this.reconnectAttempts);
          this.connectionQuality = 'poor';
          
          if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ WebSocket max reconnection attempts reached');
            this.emit('connection-failed');
          }
        });

        this.socket.on('reconnect_failed', () => {
          console.error('❌ WebSocket reconnection completely failed');
          this.connected = false;
          this.connectionQuality = 'failed';
          this.emit('connection-failed');
        });

        // Mobile-specific ping/pong monitoring
        this.socket.on('ping', () => {
          this.lastPingTime = Date.now();
        });

        this.socket.on('pong', (latency) => {
          const pingTime = Date.now() - this.lastPingTime;
          console.log(`🏓 WebSocket latency: ${latency}ms (ping: ${pingTime}ms)`);
          
          // Update connection quality based on latency
          if (latency < 100) {
            this.connectionQuality = 'excellent';
          } else if (latency < 300) {
            this.connectionQuality = 'good';
          } else if (latency < 1000) {
            this.connectionQuality = 'fair';
          } else {
            this.connectionQuality = 'poor';
          }
        });

        // Set up event forwarding
        this.socket.on('note-updated', (data) => {
          this.emit('note-updated', data);
        });

        this.socket.on('note-updated-broadcast', (data) => {
          this.emit('note-updated', data);
        });

        this.socket.on('presence-changed', (data) => {
          this.emit('presence-changed', data);
        });

        this.socket.on('bulk-sync-response', (data) => {
          this.emit('bulk-sync-response', data);
        });

        this.socket.on('join-note-success', (data) => {
          this.emit('join-note-success', data);
        });

        this.socket.on('heartbeat-ack', (data) => {
          this.emit('heartbeat-ack', data);
        });

        this.socket.on('batch-saved', (data) => {
          this.emit('batch-saved', data);
        });

        this.socket.on('connection-confirmed', (data) => {
          console.log('✅ Connection confirmed from server:', data);
          // Store the server's custom connectionId for boomerang prevention
          this.serverConnectionId = data.connectionId;
          console.log('🔗 Stored server connectionId:', this.serverConnectionId);
          this.emit('connection-confirmed', data);
        });

        this.socket.on('error', (error) => {
          console.error('❌ WebSocket error:', error);
          this.emit('websocket-error', error);
        });
      });

    } catch (error) {
      console.error('❌ Failed to create WebSocket connection:', error);
      this.connected = false;
      this._isConnecting = false; // Unlock connection on outer catch
      throw error;
    } finally {
      // Always ensure connection flag is reset
      if (!this.connected) {
        this._isConnecting = false;
      }
    }
  }


  // Event emitter methods
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  off(event, handler) {
    if (this.eventHandlers.has(event)) {
      const handlers = this.eventHandlers.get(event);
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    if (this.eventHandlers.has(event)) {
      this.eventHandlers.get(event).forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error('Error in event handler:', error);
        }
      });
    }
  }

  // WebSocket methods for note collaboration
  joinNote(noteId) {
    if (this.socket && this.connected) {
      console.log('🤝 Joining note collaboration:', noteId);
      this.socket.emit('join-note', { noteId });
    } else {
      console.warn('⚠️ Cannot join note - WebSocket not connected');
    }
  }

  leaveNote(noteId) {
    if (this.socket && this.connected) {
      console.log('👋 Leaving note collaboration:', noteId);
      this.socket.emit('leave-note', { noteId });
    }
  }

/**
 * Determines whether WebSocket should be used for real-time communication
 * @returns {boolean} True if WebSocket should be used, false for HTTP fallback
 */
shouldUseWebSocket() {
  // Check if WebSocket is supported by the browser
  if (typeof WebSocket === 'undefined') {
    console.log('🚫 WebSocket not supported by browser');
    return false;
  }
  
  // Check if we're in a secure context (required for many WebSocket implementations)
  if (typeof window !== 'undefined' && window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
    console.log('🚫 WebSocket requires HTTPS in production');
    return false;
  }
  
  // Check if the service is initialized
  if (!this.socket && !this.isConnecting) {
    console.log('🚫 WebSocket service not initialized');
    return false;
  }
  
  // Check if we're currently connected or in the process of connecting
  if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
    return true;
  }
  
  // Check if we're in connecting state (service level)
  if (this.isConnecting) {
    return true;
  }
  
  // Check if we've explicitly disabled WebSocket (e.g., due to repeated failures)
  if (this.disabled) {
    console.log('🚫 WebSocket disabled due to previous failures');
    return false;
  }
  
  // Check connection state - if we've had recent failures, use HTTP fallback
  if (this.connectionFailures >= 3) {
    console.log('🚫 Too many WebSocket connection failures, using HTTP fallback');
    return false;
  }
  
  // Default to true if all checks pass
  return true;
}

  sendNoteUpdate(noteId, updates) {
    if (this.socket && this.connected) {
      this.socket.emit('note-update', {
        noteId,
        updates,
        timestamp: new Date().toISOString()
      });
    } else {
      console.warn('⚠️ Cannot send note update - WebSocket not connected');
    }
  }

  sendHeartbeat(noteId) {
    if (this.socket && this.connected) {
      this.socket.emit('heartbeat', { noteId });
    }
  }

  requestBulkSync(noteTimestamps) {
    if (this.socket && this.connected) {
      console.log('📱 Requesting bulk sync for', Object.keys(noteTimestamps).length, 'notes');
      this.socket.emit('bulk-sync-request', { noteTimestamps });
    }
  }

  isConnected() {
    return this.connected && this.socket && this.socket.connected;
  }

  getConnectionId() {
    // Return server's custom connectionId for boomerang prevention, fallback to socket.id
    return this.serverConnectionId || (this.socket ? this.socket.id : null);
  }
}

// Create and export a singleton instance
const websocketService = new WebSocketService();
export default websocketService;
