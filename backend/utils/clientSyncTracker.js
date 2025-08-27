/**
 * Client Sync Tracker - Manages per-client hash tracking for precise offline conflict detection
 * 
 * This module tracks the last content hash sent to each client for each note,
 * enabling precise conflict detection when clients come back online.
 */

const fs = require('fs-extra');
const path = require('path');

class ClientSyncTracker {
  constructor() {
    this.syncStateFile = path.join(process.cwd(), 'data', 'client-sync-state.json');
    this.syncState = new Map(); // clientId -> noteId -> { lastSentHash, lastSentAt }
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    try {
      // Ensure data directory exists
      await fs.ensureDir(path.dirname(this.syncStateFile));
      
      // Load existing sync state if it exists
      if (await fs.pathExists(this.syncStateFile)) {
        const data = await fs.readJson(this.syncStateFile);
        
        // Convert plain object back to nested Maps
        for (const [clientId, noteMap] of Object.entries(data)) {
          this.syncState.set(clientId, new Map(Object.entries(noteMap)));
        }
        
        console.log(`📊 Loaded sync state for ${this.syncState.size} clients`);
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize ClientSyncTracker:', error);
      // Continue with empty state
      this.initialized = true;
    }
  }

  /**
   * Record that we sent a specific hash to a client for a note
   */
  async recordSentToClient(clientId, noteId, contentHash) {
    await this.initialize();
    
    if (!this.syncState.has(clientId)) {
      this.syncState.set(clientId, new Map());
    }
    
    const clientNotes = this.syncState.get(clientId);
    clientNotes.set(noteId, {
      lastSentHash: contentHash,
      lastSentAt: new Date().toISOString()
    });
    
    // Persist to disk asynchronously (fire and forget to avoid slowing down responses)
    this.persistStateAsync().catch(error => {
      console.warn('⚠️ Failed to persist client sync state:', error.message);
    });
  }

  /**
   * Get the last hash we sent to a specific client for a note
   */
  async getLastSentToClient(clientId, noteId) {
    await this.initialize();
    
    const clientNotes = this.syncState.get(clientId);
    if (!clientNotes) return null;
    
    const syncInfo = clientNotes.get(noteId);
    return syncInfo ? syncInfo.lastSentHash : null;
  }

  /**
   * Get sync metadata for a client-note combination
   */
  async getSyncMetadata(clientId, noteId) {
    await this.initialize();
    
    const clientNotes = this.syncState.get(clientId);
    if (!clientNotes) return null;
    
    return clientNotes.get(noteId) || null;
  }

  /**
   * Clean up old sync state entries (older than 30 days)
   */
  async cleanupOldEntries() {
    await this.initialize();
    
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let cleanedCount = 0;
    
    for (const [clientId, clientNotes] of this.syncState.entries()) {
      for (const [noteId, syncInfo] of clientNotes.entries()) {
        const lastSentDate = new Date(syncInfo.lastSentAt);
        if (lastSentDate < thirtyDaysAgo) {
          clientNotes.delete(noteId);
          cleanedCount++;
        }
      }
      
      // Remove empty client entries
      if (clientNotes.size === 0) {
        this.syncState.delete(clientId);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} old sync state entries`);
      await this.persistStateAsync();
    }
  }

  /**
   * Remove all sync state for a specific client (e.g., when client disconnects permanently)
   */
  async removeClient(clientId) {
    await this.initialize();
    
    if (this.syncState.delete(clientId)) {
      console.log(`🗑️ Removed sync state for client ${clientId}`);
      await this.persistStateAsync();
    }
  }

  /**
   * Get statistics about current sync state
   */
  async getStats() {
    await this.initialize();
    
    let totalNoteEntries = 0;
    for (const clientNotes of this.syncState.values()) {
      totalNoteEntries += clientNotes.size;
    }
    
    return {
      clientCount: this.syncState.size,
      totalNoteEntries,
      memoryUsage: process.memoryUsage().heapUsed
    };
  }

  /**
   * Persist current sync state to disk (async, non-blocking)
   */
  async persistStateAsync() {
    try {
      // Convert Maps to plain objects for JSON serialization
      const plainObject = {};
      for (const [clientId, noteMap] of this.syncState.entries()) {
        plainObject[clientId] = Object.fromEntries(noteMap.entries());
      }
      
      await fs.writeJson(this.syncStateFile, plainObject, { spaces: 2 });
    } catch (error) {
      console.error('❌ Failed to persist client sync state:', error);
    }
  }
}

// Export singleton instance
module.exports = new ClientSyncTracker();