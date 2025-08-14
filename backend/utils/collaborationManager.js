// 4. Create utils/collaborationManager.js - Redis-backed collaboration
const { getRedisClients } = require('../config/redis');

class CollaborationManager {
  constructor() {
    this.fallbackActiveEditors = new Map(); // Fallback for when Redis unavailable
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
          lastSeen: new Date().toISOString()
        };
        
        await redisClient.hset(key, userId, JSON.stringify(editorData));
        await redisClient.expire(key, 600); // 10 minutes TTL
        
        // Publish presence update
        await this.publishPresenceUpdate(noteId, 'join', userId, editorData);
        
        console.log(`User ${userId} joined editing note ${noteId} (Redis)`);
      } else {
        // Fallback to memory
        if (!this.fallbackActiveEditors.has(noteId)) {
          this.fallbackActiveEditors.set(noteId, new Map());
        }
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        noteEditors.set(userId, {
          ...editorInfo,
          id: userId,
          joinedAt: new Date(),
          lastSeen: new Date()
        });
        console.log(`User ${userId} joined editing note ${noteId} (Memory fallback)`);
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
        await redisClient.hdel(key, userId);
        
        // Check if any editors left
        const editorsCount = await redisClient.hlen(key);
        if (editorsCount === 0) {
          await redisClient.del(key);
        }
        
        // Publish presence update
        await this.publishPresenceUpdate(noteId, 'leave', userId);
        
        console.log(`User ${userId} left editing note ${noteId} (Redis)`);
      } else {
        // Fallback to memory
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        if (noteEditors) {
          noteEditors.delete(userId);
          if (noteEditors.size === 0) {
            this.fallbackActiveEditors.delete(noteId);
          }
        }
        console.log(`User ${userId} left editing note ${noteId} (Memory fallback)`);
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
        const staleThreshold = 2 * 60 * 1000; // 2 minutes
        
        for (const [userId, editorData] of Object.entries(editors)) {
          try {
            const editor = JSON.parse(editorData);
            const lastSeen = new Date(editor.lastSeen);
            
            if (now - lastSeen <= staleThreshold) {
              activeEditors.push(editor);
            } else {
              // Remove stale editor
              await redisClient.hdel(key, userId);
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
        const staleThreshold = 2 * 60 * 1000;
        const activeEditors = [];
        
        for (const [userId, editor] of noteEditors.entries()) {
          if (now - editor.lastSeen <= staleThreshold) {
            activeEditors.push(editor);
          } else {
            noteEditors.delete(userId);
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
          await redisClient.hset(key, userId, JSON.stringify(editor));
          await redisClient.expire(key, 600); // Refresh TTL
        }
      } else {
        // Fallback to memory
        const noteEditors = this.fallbackActiveEditors.get(noteId);
        if (noteEditors?.has(userId)) {
          const editor = noteEditors.get(userId);
          editor.lastSeen = new Date();
          noteEditors.set(userId, editor);
        }
      }
    } catch (error) {
      console.error('Error updating editor last seen:', error);
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
    noteEditors.set(userId, {
      ...editorInfo,
      id: userId,
      joinedAt: new Date(),
      lastSeen: new Date()
    });
  }

  removeActiveEditorFallback(noteId, userId) {
    const noteEditors = this.fallbackActiveEditors.get(noteId);
    if (noteEditors) {
      noteEditors.delete(userId);
      if (noteEditors.size === 0) {
        this.fallbackActiveEditors.delete(noteId);
      }
    }
  }

  getActiveEditorsFallback(noteId) {
    const noteEditors = this.fallbackActiveEditors.get(noteId);
    return noteEditors ? Array.from(noteEditors.values()) : [];
  }

  // Cleanup method for stale editors
  async cleanupStaleEditors() {
    const { redisClient } = getRedisClients();
    
    try {
      if (redisClient) {
        // Redis TTL handles most cleanup, but we can scan for patterns
        const keys = await redisClient.keys('active_editors:*');
        for (const key of keys) {
          await this.getActiveEditors(key.replace('active_editors:', ''));
        }
      } else {
        // Cleanup memory fallback
        const now = new Date();
        const staleThreshold = 5 * 60 * 1000; // 5 minutes
        
        for (const [noteId, editors] of this.fallbackActiveEditors.entries()) {
          for (const [userId, editor] of editors.entries()) {
            if (now - editor.lastSeen > staleThreshold) {
              editors.delete(userId);
              console.log(`Cleaned up stale editor ${userId} from note ${noteId}`);
            }
          }
          
          if (editors.size === 0) {
            this.fallbackActiveEditors.delete(noteId);
          }
        }
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }
}

// Singleton instance
const collaborationManager = new CollaborationManager();

// Start cleanup interval
setInterval(() => {
  collaborationManager.cleanupStaleEditors();
}, 60000); // Run every minute

module.exports = collaborationManager;
