// Enhanced utils/collaborationManager.js - Redis-backed collaboration with WebSocket integration
const { getRedisClients } = require('../config/redis');

class CollaborationManager {
  constructor() {
    this.fallbackActiveEditors = new Map(); // Fallback for when Redis unavailable
    this.io = null; // Will be set by server.js
  }

  // Set Socket.IO instance for real-time events
  setSocketIO(ioInstance) {
    this.io = ioInstance;
    console.log('🔌 CollaborationManager: Socket.IO instance configured');
  }

  async addActiveEditor(noteId, userId, editorInfo) {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        const key = `active_editors:${noteId}`;
        const editorData = {
          ...editorInfo,
          id: userId,
          joinedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          isOnline: true
        };
        
        await redisClient.hset(key, userId, JSON.stringify(editorData));
        await redisClient.expire(key, 600); // 10 minutes TTL
        
        // Publish presence update to Redis subscribers
        await this.publishPresenceUpdate(noteId, 'join', userId, editorData);
        
        // Emit real-time WebSocket event
        await this.emitPresenceChange(noteId, 'join', userId, editorData);
        
        console.log(`👥 User ${userId} joined editing note ${noteId} (Redis + WebSocket)`);
      } else {
        // Fallback to memory
        if (!this.fallbackActiveEditors.has(noteId)) {
          this.fallbackActiveEditors.set(noteId, new Map());
        }
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        const editorData = {
          ...editorInfo,
          id: userId,
          joinedAt: new Date(),
          lastSeen: new Date(),
          isOnline: true
        };
        noteEditors.set(userId, editorData);
        
        // Emit WebSocket event even in fallback mode
        await this.emitPresenceChange(noteId, 'join', userId, editorData);
        
        console.log(`👥 User ${userId} joined editing note ${noteId} (Memory fallback + WebSocket)`);
      }
    } catch (error) {
      console.error('Error adding active editor:', error);
      // Fallback to memory on Redis error
      this.addActiveEditorFallback(noteId, userId, editorInfo);
    }
  }

  async removeActiveEditor(noteId, userId) {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        const key = `active_editors:${noteId}`;
        
        // Get editor data before removing for WebSocket event
        const editorDataString = await redisClient.hget(key, userId);
        let editorData = null;
        if (editorDataString) {
          try {
            editorData = JSON.parse(editorDataString);
          } catch (parseError) {
            console.error('Error parsing editor data during removal:', parseError);
          }
        }
        
        await redisClient.hdel(key, userId);
        
        // Check if any editors left
        const editorsCount = await redisClient.hlen(key);
        if (editorsCount === 0) {
          await redisClient.del(key);
        }
        
        // Publish presence update to Redis subscribers
        await this.publishPresenceUpdate(noteId, 'leave', userId, editorData);
        
        // Emit real-time WebSocket event
        await this.emitPresenceChange(noteId, 'leave', userId, editorData);
        
        console.log(`👥 User ${userId} left editing note ${noteId} (Redis + WebSocket)`);
      } else {
        // Fallback to memory
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        let editorData = null;
        if (noteEditors) {
          editorData = noteEditors.get(userId);
          noteEditors.delete(userId);
          if (noteEditors.size === 0) {
            this.fallbackActiveEditors.delete(noteId);
          }
        }
        
        // Emit WebSocket event even in fallback mode
        await this.emitPresenceChange(noteId, 'leave', userId, editorData);
        
        console.log(`👥 User ${userId} left editing note ${noteId} (Memory fallback + WebSocket)`);
      }
    } catch (error) {
      console.error('Error removing active editor:', error);
      this.removeActiveEditorFallback(noteId, userId);
    }
  }

  async getActiveEditors(noteId) {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        const key = `active_editors:${noteId}`;
        const editors = await redisClient.hgetall(key);
        
        // Parse and filter active editors
        const activeEditors = [];
        const now = new Date();
        const staleThreshold = 5 * 60 * 1000; // 5 minutes (increased for WebSocket reliability)
        
        for (const [userId, editorData] of Object.entries(editors)) {
          try {
            const editor = JSON.parse(editorData);
            const lastSeen = new Date(editor.lastSeen);
            
            if (now - lastSeen <= staleThreshold) {
              activeEditors.push(editor);
            } else {
              // Remove stale editor
              await redisClient.hdel(key, userId);
              console.log(`🧹 Removed stale editor ${userId} from note ${noteId}`);
            }
          } catch (parseError) {
            console.error('Error parsing editor data:', parseError);
            await redisClient.hdel(key, userId);
          }
        }
        
        return activeEditors;
      } else {
        // Fallback to memory
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        if (!noteEditors) return [];
        
        const now = new Date();
        const staleThreshold = 5 * 60 * 1000;
        const activeEditors = [];
        
        for (const [userId, editor] of noteEditors.entries()) {
          if (now - editor.lastSeen <= staleThreshold) {
            activeEditors.push(editor);
          } else {
            noteEditors.delete(userId);
            console.log(`🧹 Removed stale editor ${userId} from note ${noteId} (memory)`);
          }
        }
        
        return activeEditors;
      }
    } catch (error) {
      console.error('Error getting active editors:', error);
      return this.getActiveEditorsFallback(noteId);
    }
  }

  async updateEditorLastSeen(noteId, userId) {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        const key = `active_editors:${noteId}`;
        const editorData = await redisClient.hget(key, userId);
        
        if (editorData) {
          const editor = JSON.parse(editorData);
          editor.lastSeen = new Date().toISOString();
          editor.isOnline = true;
          await redisClient.hset(key, userId, JSON.stringify(editor));
          await redisClient.expire(key, 600); // Refresh TTL
          
          // Emit heartbeat acknowledgment via WebSocket
          await this.emitHeartbeat(noteId, userId, editor);
        }
      } else {
        // Fallback to memory
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        if (noteEditors?.has(userId)) {
          const editor = noteEditors.get(userId);
          editor.lastSeen = new Date();
          editor.isOnline = true;
          noteEditors.set(userId, editor);
          
          // Emit heartbeat acknowledgment via WebSocket
          await this.emitHeartbeat(noteId, userId, editor);
        }
      }
    } catch (error) {
      console.error('Error updating editor last seen:', error);
    }
  }

  // NEW: Set mobile presence indicator
  async setMobilePresence(noteId, userId, isMobile = true) {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        const key = `active_editors:${noteId}`;
        const editorData = await redisClient.hget(key, userId);
        
        if (editorData) {
          const editor = JSON.parse(editorData);
          editor.isMobile = isMobile;
          editor.lastSeen = new Date().toISOString();
          await redisClient.hset(key, userId, JSON.stringify(editor));
          
          // Emit presence update
          await this.emitPresenceChange(noteId, 'mobile-status', userId, editor);
        }
      } else {
        // Fallback to memory
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        if (noteEditors?.has(userId)) {
          const editor = noteEditors.get(userId);
          editor.isMobile = isMobile;
          editor.lastSeen = new Date();
          noteEditors.set(userId, editor);
          
          // Emit presence update
          await this.emitPresenceChange(noteId, 'mobile-status', userId, editor);
        }
      }
    } catch (error) {
      console.error('Error setting mobile presence:', error);
    }
  }

  // NEW: Get sync recommendations based on editor activity
  async getSyncRecommendations(noteId) {
    try {
      const activeEditors = await this.getActiveEditors(noteId);
      const mobileEditors = activeEditors.filter(editor => editor.isMobile);
      const desktopEditors = activeEditors.filter(editor => !editor.isMobile);
      
      return {
        totalActiveEditors: activeEditors.length,
        mobileEditorsCount: mobileEditors.length,
        desktopEditorsCount: desktopEditors.length,
        recommendHighFrequency: activeEditors.length > 1,
        recommendBulkSync: mobileEditors.length > 0,
        syncInterval: activeEditors.length > 1 ? 3000 : 15000 // 3s vs 15s
      };
    } catch (error) {
      console.error('Error getting sync recommendations:', error);
      return {
        totalActiveEditors: 0,
        mobileEditorsCount: 0,
        desktopEditorsCount: 0,
        recommendHighFrequency: false,
        recommendBulkSync: false,
        syncInterval: 15000
      };
    }
  }

  // NEW: Emit real-time note update via WebSocket
  async emitNoteUpdate(noteId, updates, editorInfo) {
    try {
      if (this.io) {
        this.io.to(`note:${noteId}`).emit('note-updated-broadcast', {
          noteId,
          updates,
          editor: editorInfo,
          timestamp: new Date().toISOString()
        });
        console.log(`📡 Broadcasted note update for ${noteId} via WebSocket`);
      }
    } catch (error) {
      console.error('Error emitting note update:', error);
    }
  }

  // NEW: Emit conflict detection via WebSocket
  async emitConflictDetected(noteId, conflictInfo) {
    try {
      if (this.io) {
        this.io.to(`note:${noteId}`).emit('conflict-detected', {
          noteId,
          conflict: conflictInfo,
          timestamp: new Date().toISOString()
        });
        console.log(`⚠️ Broadcasted conflict detection for ${noteId} via WebSocket`);
      }
    } catch (error) {
      console.error('Error emitting conflict detection:', error);
    }
  }

  // WebSocket event emission methods
  async emitPresenceChange(noteId, action, userId, editorData) {
    try {
      if (this.io) {
        const activeEditors = await this.getActiveEditors(noteId);
        
        this.io.to(`note:${noteId}`).emit('presence-changed', {
          noteId,
          action,
          userId,
          editorData,
          activeEditors,
          timestamp: new Date().toISOString()
        });
        
        console.log(`📡 Emitted presence change: ${action} for user ${userId} in note ${noteId}`);
      }
    } catch (error) {
      console.error('Error emitting presence change:', error);
    }
  }

  async emitHeartbeat(noteId, userId, editorData) {
    try {
      if (this.io) {
        // Send heartbeat to specific user's socket
        const sockets = await this.io.in(`note:${noteId}`).fetchSockets();
        const userSocket = sockets.find(socket => socket.userId === userId);
        
        if (userSocket) {
          userSocket.emit('heartbeat-response', {
            noteId,
            timestamp: new Date().toISOString(),
            status: 'acknowledged'
          });
        }
      }
    } catch (error) {
      console.error('Error emitting heartbeat:', error);
    }
  }

  async publishPresenceUpdate(noteId, action, userId, editorData = null) {
    const { redisPublisher } = getRedisClients();
    
    try {
      if (redisPublisher) {
        const message = {
          noteId,
          action,
          userId,
          editorData,
          timestamp: new Date().toISOString()
        };
        
        await redisPublisher.publish(`presence:${noteId}`, JSON.stringify(message));
        console.log(`📮 Published presence update to Redis: ${action} for user ${userId}`);
      }
    } catch (error) {
      console.error('Error publishing presence update:', error);
    }
  }

  // Fallback methods for memory-based operations
  addActiveEditorFallback(noteId, userId, editorInfo) {
    if (!this.fallbackActiveEditors.has(noteId)) {
      this.fallbackActiveEditors.set(noteId, new Map());
    }
    const noteEditors = this.fallbackActiveEditors.get(noteId);
    const editorData = {
      ...editorInfo,
      id: userId,
      joinedAt: new Date(),
      lastSeen: new Date(),
      isOnline: true
    };
    noteEditors.set(userId, editorData);
    
    // Still emit WebSocket events in fallback mode
    this.emitPresenceChange(noteId, 'join', userId, editorData);
  }

  removeActiveEditorFallback(noteId, userId) {
    const noteEditors = this.fallbackActiveEditors.get(noteId);
    let editorData = null;
    if (noteEditors) {
      editorData = noteEditors.get(userId);
      noteEditors.delete(userId);
      if (noteEditors.size === 0) {
        this.fallbackActiveEditors.delete(noteId);
      }
    }
    
    // Still emit WebSocket events in fallback mode
    this.emitPresenceChange(noteId, 'leave', userId, editorData);
  }

  getActiveEditorsFallback(noteId) {
    const noteEditors = this.fallbackActiveEditors.get(noteId);
    return noteEditors ? Array.from(noteEditors.values()) : [];
  }

  // Enhanced cleanup method for stale editors
  async cleanupStaleEditors() {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        // Redis TTL handles most cleanup, but we can scan for patterns
        const keys = await redisClient.keys('active_editors:*');
        for (const key of keys) {
          const noteId = key.replace('active_editors:', '');
          const editorsBeforeCleanup = await this.getActiveEditors(noteId);
          
          // getActiveEditors already handles cleanup, but we can emit events if needed
          if (editorsBeforeCleanup.length === 0) {
            // Note has no active editors - could emit a "note-inactive" event
            if (this.io) {
              this.io.to(`note:${noteId}`).emit('note-inactive', {
                noteId,
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      } else {
        // Cleanup memory fallback
        const now = new Date();
        const staleThreshold = 10 * 60 * 1000; // 10 minutes for cleanup
        
        for (const [noteId, editors] of this.fallbackActiveEditors.entries()) {
          const editorsToRemove = [];
          
          for (const [userId, editor] of editors.entries()) {
            if (now - editor.lastSeen > staleThreshold) {
              editorsToRemove.push({ userId, editor });
            }
          }
          
          // Remove stale editors and emit events
          for (const { userId, editor } of editorsToRemove) {
            editors.delete(userId);
            await this.emitPresenceChange(noteId, 'timeout', userId, editor);
            console.log(`🧹 Cleaned up stale editor ${userId} from note ${noteId}`);
          }
          
          if (editors.size === 0) {
            this.fallbackActiveEditors.delete(noteId);
            // Emit note-inactive event
            if (this.io) {
              this.io.to(`note:${noteId}`).emit('note-inactive', {
                noteId,
                timestamp: new Date().toISOString()
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  // NEW: Force sync for specific note (triggered by HTTP endpoint)
  async triggerNoteSync(noteId, updates, editorInfo) {
    try {
      // Emit to all connected clients for this note
      await this.emitNoteUpdate(noteId, updates, editorInfo);
      
      // Update editor activity
      if (editorInfo?.id) {
        await this.updateEditorLastSeen(noteId, editorInfo.id);
      }
    } catch (error) {
      console.error('Error triggering note sync:', error);
    }
  }
}

// Singleton instance
const collaborationManager = new CollaborationManager();

// Start cleanup interval (increased frequency for better WebSocket reliability)
setInterval(() => {
  collaborationManager.cleanupStaleEditors();
}, 30000); // Run every 30 seconds instead of 60

module.exports = collaborationManager;