// Simple, reliable WebSocket connection manager
// ONE connection, clear state, no multiple connection attempts

import { io } from 'socket.io-client';

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
    this.token = null;
    this.currentNoteId = null;
    this.eventListeners = new Map();
    
    // Connection settings - simple and reliable
    this.connectionConfig = {
      transports: ['websocket', 'polling'],
      timeout: 20000,
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      pingTimeout: 60000,
      pingInterval: 25000
    };
    
    console.log('🔌 WebSocketManager initialized');
  }

  // Get current connection state
  getState() {
    return {
      state: this.state,
      connected: this.state === 'connected',
      socket: this.socket,
      noteId: this.currentNoteId
    };
  }

  // Add event listener
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  // Remove event listener
  off(event, callback) {
    if (this.eventListeners.has(event)) {
      const callbacks = this.eventListeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  // Emit event to listeners
  emit(event, data) {
    if (this.eventListeners.has(event)) {
      this.eventListeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in WebSocket event handler for ${event}:`, error);
        }
      });
    }
  }

  // Main connection method - ONLY way to connect
  async connect(token) {
    // Rule 1: If already connecting or connected, return current state
    if (this.state === 'connecting') {
      console.log('🔒 Already connecting, waiting...');
      return this.waitForConnection();
    }
    
    if (this.state === 'connected' && this.socket) {
      console.log('✅ Already connected');
      return Promise.resolve();
    }

    console.log('🔌 Starting WebSocket connection...');
    this.state = 'connecting';
    this.token = token;

    // Clean up any existing connection
    this.cleanup();

    try {
      const socketUrl = this.getSocketUrl();
      console.log(`🔗 Connecting to: ${socketUrl}`);

      this.socket = io(socketUrl, {
        ...this.connectionConfig,
        auth: { token }
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Wait for connection
      await this.waitForConnection();
      
      console.log('✅ WebSocket connected successfully');
      return Promise.resolve();

    } catch (error) {
      console.error('❌ WebSocket connection failed:', error);
      this.state = 'disconnected';
      this.cleanup();
      throw error;
    }
  }

  // Wait for connection to complete
  waitForConnection() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.state = 'disconnected';
        this.cleanup();
      }, this.connectionConfig.timeout);

      const checkState = () => {
        if (this.state === 'connected') {
          clearTimeout(timeout);
          resolve();
        } else if (this.state === 'disconnected') {
          clearTimeout(timeout);
          reject(new Error('Connection failed'));
        } else {
          // Still connecting, check again
          setTimeout(checkState, 100);
        }
      };

      checkState();
    });
  }

  // Set up all event handlers in one place
  setupEventHandlers() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('🔗 Socket connected');
      this.state = 'connected';
      this.emit('connected');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('🔌 Socket disconnected:', reason);
      this.state = 'disconnected';
      this.currentNoteId = null;
      this.emit('disconnected', reason);
    });

    this.socket.on('connect_error', (error) => {
      console.error('❌ Socket connection error:', error);
      this.state = 'disconnected';
      this.emit('connection_error', error);
    });

    // Forward application events
    this.socket.on('connection-confirmed', (data) => {
      console.log('✅ Connection confirmed:', data);
      this.emit('connection-confirmed', data);
    });

    this.socket.on('note-updated', (data) => {
      console.log('📝 Note update received:', data);
      this.emit('note-updated', data);
    });

    this.socket.on('presence-changed', (data) => {
      this.emit('presence-changed', data);
    });

    this.socket.on('join-note-success', (data) => {
      console.log('✅ Joined note successfully:', data.noteId);
      this.currentNoteId = data.noteId;
      this.emit('join-note-success', data);
    });

    this.socket.on('batch-saved', (data) => {
      this.emit('batch-saved', data);
    });

    this.socket.on('error', (error) => {
      console.error('❌ Socket error:', error);
      this.emit('error', error);
    });
  }

  // Get Socket.IO URL
  getSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port;
    
    if (port && port !== '80' && port !== '443') {
      return `${protocol}//${host}:${port}`;
    } else {
      return `${protocol}//${host}`;
    }
  }

  // Disconnect
  disconnect() {
    console.log('🔌 Disconnecting WebSocket');
    this.state = 'disconnected';
    this.currentNoteId = null;
    this.cleanup();
    this.emit('disconnected', 'manual');
  }

  // Clean up socket
  cleanup() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // Join note collaboration
  joinNote(noteId) {
    if (this.state !== 'connected' || !this.socket) {
      console.warn('⚠️ Cannot join note - not connected');
      return false;
    }

    console.log(`🤝 Joining note: ${noteId}`);
    this.socket.emit('join-note', { noteId });
    return true;
  }

  // Leave note collaboration
  leaveNote(noteId) {
    if (this.socket) {
      console.log(`👋 Leaving note: ${noteId}`);
      this.socket.emit('leave-note', { noteId });
    }
    if (this.currentNoteId === noteId) {
      this.currentNoteId = null;
    }
  }

  // Send note update
  sendNoteUpdate(noteId, updates) {
    if (this.state !== 'connected' || !this.socket) {
      console.warn('⚠️ Cannot send update - not connected');
      return false;
    }

    const payload = {
      noteId,
      updates,
      timestamp: new Date().toISOString()
    };
    
    const payloadSize = JSON.stringify(payload).length;
    const isDiffBased = !!updates.contentDiff;
    const mode = updates._mode || (isDiffBased ? 'diff' : 'full');
    
    console.log(`📡 [WEBSOCKET] Sending ${mode.toUpperCase()} update for note ${noteId}:`, {
      mode,
      payloadSize: `${payloadSize} bytes`,
      hasContentDiff: !!updates.contentDiff,
      hasFullContent: !!updates.content,
      contentLength: updates.contentLength || updates.content?.length || 0,
      patches: updates.contentDiff?.length || 0
    });
    
    this.socket.emit('note-update', payload);
    return true;
  }

  // Send heartbeat
  sendHeartbeat(noteId) {
    if (this.state === 'connected' && this.socket) {
      this.socket.emit('heartbeat', { noteId });
    }
  }

  // Request bulk sync
  requestBulkSync(noteTimestamps) {
    if (this.state === 'connected' && this.socket) {
      console.log('📱 Requesting bulk sync');
      this.socket.emit('bulk-sync-request', { noteTimestamps });
    }
  }

  // Get connection ID for boomerang prevention
  getConnectionId() {
    return this.socket?.id || null;
  }
}

// Create singleton instance
const webSocketManager = new WebSocketManager();

// Make it globally available
if (typeof window !== 'undefined') {
  window.webSocketManager = webSocketManager;
}

export default webSocketManager;