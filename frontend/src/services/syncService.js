// src/services/syncService.js - Complete file
import api from '../utils/api';

class SyncService {
  constructor() {
    this.lastGlobalSync = null;
    this.syncInProgress = false;
    this.pendingNotes = new Set();
  }
  
  // Generate content hash for change detection (client-side)
  async generateContentHash(title, content) {
    const combined = `${title || ''}|||${content || ''}`;
    
    // Use Web Crypto API with SHA-256 (MD5 not supported in browsers)
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 8);
  }

  // NEW: Intelligent bulk sync using metadata pre-filtering
  async syncAllNotes(notes, currentUser) {
    if (this.syncInProgress || !notes || notes.length === 0) {
      console.log('⭐ Skipping sync - already in progress or no notes');
      return { updatedNotes: [], conflicts: [] };
    }

    this.syncInProgress = true;
    console.log(`⚡ Starting INTELLIGENT bulk sync for ${notes.length} notes`);

    try {
      const results = {
        updatedNotes: [],
        conflicts: [],
        errors: [],
        newNotes: [],
        deletedNoteIds: [],
        stats: {
          totalNotes: notes.length,
          serverCalls: 0,
          skipped: 0,
          checked: 0
        }
      };

      // STEP 1: Create client metadata map with hashes
      console.log('🔄 Step 1: Building client metadata map...');
      const clientMetadata = {};
      
      // Generate hashes for all notes in parallel
      const hashPromises = notes.map(async (note) => {
        const contentHash = await this.generateContentHash(note.title, note.content);
        return {
          id: note.id,
          metadata: {
            id: note.id,
            updatedAt: note.updatedAt,
            contentHash: contentHash,
            title: note.title || '',
            shared: note.shared || false,
            hasBeenShared: note.hasBeenShared || false
          }
        };
      });
      
      const hashResults = await Promise.all(hashPromises);
      hashResults.forEach(result => {
        clientMetadata[result.id] = result.metadata;
      });
      
      console.log(`✅ Built metadata for ${Object.keys(clientMetadata).length} notes`);

      // STEP 2: Get server metadata in ONE API call
      console.log('🔄 Step 2: Fetching server metadata...');
      let serverResponse;
      try {
        // Try new efficient endpoint first
        serverResponse = await api.get('/api/notes/sync-metadata');
        console.log('Actual serverResponse object:', serverResponse); 
        results.stats.serverCalls++;
        console.log(`✅ Server metadata received for ${serverResponse.data.count} notes`);
      } catch (error) {
        console.warn('⚠️ New sync-metadata endpoint not available, trying bulk-sync fallback...');
        console.error('Full error object:', error);
        // Fallback to existing bulk-sync with timestamp-only comparison
        try {
          const timestamps = {};
          notes.forEach(note => {
            timestamps[note.id] = note.updatedAt || new Date(0).toISOString();
          });
          
          const bulkResponse = await api.post('/api/notes/bulk-sync', {
            noteTimestamps: timestamps
          });
          results.stats.serverCalls++;
          
          console.log(`✅ Bulk sync fallback returned ${bulkResponse.data.updatedNotes?.length || 0} updates`);
          
          return {
            updatedNotes: bulkResponse.data.updatedNotes || [],
            conflicts: bulkResponse.data.conflicts || [],
            errors: [],
            deletedNoteIds: [],
            stats: {
              ...results.stats,
              foundUpdates: bulkResponse.data.updatedNotes?.length || 0,
              serverCalls: results.stats.serverCalls
            }
          };
          
        } catch (bulkError) {
          console.error('❌ Both new and bulk-sync endpoints failed, falling back to legacy method:', bulkError);
          return await this.syncAllNotesLegacy(notes, currentUser);
        }
      }

      const serverMetadata = serverResponse.data.metadata;
      const clientNoteIds = new Set(Object.keys(clientMetadata));
      const serverNoteIds = new Set(Object.keys(serverMetadata));
      
      // STEP 3: Intelligent filtering - find notes that actually changed
      console.log('🔄 Step 3: Intelligent change detection...');
      const notesToFetch = [];
      
      // Check each server note
      for (const [noteId, serverMeta] of Object.entries(serverMetadata)) {
        results.stats.checked++;
        const clientMeta = clientMetadata[noteId];
        
        if (!clientMeta) {
          // New note - need to fetch
          notesToFetch.push(noteId);
          console.log(`🆕 Note ${noteId} is NEW`);
        } else if (serverMeta.contentHash !== clientMeta.contentHash) {
          // Content changed - need to fetch
          notesToFetch.push(noteId);
          console.log(`🔄 Note ${noteId} CHANGED (hash: ${clientMeta.contentHash} → ${serverMeta.contentHash})`);
        } else if (new Date(serverMeta.updatedAt).getTime() > new Date(clientMeta.updatedAt || 0).getTime()) {
          // Timestamp changed but hash same - still fetch as fallback
          notesToFetch.push(noteId);
          console.log(`⏰ Note ${noteId} timestamp differs despite same hash`);
        } else {
          // No changes - identical hash and timestamp
          results.stats.skipped++;
        }
        
        clientNoteIds.delete(noteId);
      }
      
      // Notes that exist on client but not server = deleted
      results.deletedNoteIds = Array.from(clientNoteIds);
      if (results.deletedNoteIds.length > 0) {
        console.log(`🗑️ Found ${results.deletedNoteIds.length} deleted notes:`, results.deletedNoteIds);
      }

      // STEP 4: Fetch only changed notes using efficient sync endpoint
      if (notesToFetch.length > 0) {
        console.log(`🔄 Step 4: Fetching ${notesToFetch.length} changed notes (instead of all ${notes.length})...`);
        
        try {
          const syncResponse = await api.post('/api/notes/efficient-sync', {
            clientMetadata: clientMetadata, // Send ALL client metadata for comparison
            notesToFetch: notesToFetch // Send specific list of notes that need fetching
          });
          results.stats.serverCalls++;
          
          results.updatedNotes = syncResponse.data.updatedNotes || [];
          results.newNotes = syncResponse.data.newNotes || [];
          
          console.log(`✅ Efficient sync returned:`, {
            updated: results.updatedNotes.length,
            new: results.newNotes.length
          });
          
        } catch (error) {
          console.error('❌ Efficient sync failed, trying individual fetches:', error);
          // Fallback: fetch notes individually
          results.stats.serverCalls += notesToFetch.length;
          for (const noteId of notesToFetch) {
            try {
              const noteResponse = await api.get(`/api/notes/${noteId}`);
              results.updatedNotes.push(noteResponse.data);
            } catch (noteError) {
              results.errors.push({ noteId, error: noteError.message });
            }
          }
        }
      } else {
        console.log('✅ No notes need fetching - all up to date!');
      }

      // Combine updated and new notes
      const allUpdatedNotes = [...results.updatedNotes, ...results.newNotes];
      
      const efficiency = results.stats.checked > 0 ? 
        Math.round((results.stats.skipped / results.stats.checked) * 100) : 0;

      console.log('✅ INTELLIGENT bulk sync complete:', {
        totalNotes: results.stats.totalNotes,
        serverCalls: results.stats.serverCalls,
        updated: results.updatedNotes.length,
        new: results.newNotes.length,
        deleted: results.deletedNoteIds.length,
        skipped: results.stats.skipped,
        efficiency: `${efficiency}% skipped`,
        conflicts: results.conflicts.length,
        errors: results.errors.length
      });

      this.lastGlobalSync = Date.now();
      return {
        updatedNotes: allUpdatedNotes,
        conflicts: results.conflicts,
        errors: results.errors,
        deletedNoteIds: results.deletedNoteIds,
        stats: results.stats
      };

    } catch (error) {
      console.error('❌ Intelligent bulk sync failed:', error);
      return { updatedNotes: [], conflicts: [], errors: [{ error: error.message }] };
    } finally {
      this.syncInProgress = false;
    }
  }
  
  // Legacy fallback method (old approach)
  async syncAllNotesLegacy(notes, currentUser) {
    console.log('🔄 Using LEGACY bulk sync approach...');
    
    const results = {
      updatedNotes: [],
      conflicts: [],
      errors: []
    };

    // Process notes in parallel but limit concurrency
    const batchSize = 5;
    for (let i = 0; i < notes.length; i += batchSize) {
      const batch = notes.slice(i, i + batchSize);
      const batchPromises = batch.map(note => this.checkNoteForUpdates(note, currentUser));
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        const note = batch[index];
        if (result.status === 'fulfilled' && result.value) {
          const { hasUpdates, conflict, updatedNote, error } = result.value;
          
          if (error) {
            results.errors.push({ noteId: note.id, error });
          } else if (conflict) {
            results.conflicts.push({ note, conflict });
          } else if (hasUpdates && updatedNote) {
            results.updatedNotes.push(updatedNote);
          }
        } else {
          results.errors.push({ 
            noteId: note.id, 
            error: result.reason?.message || 'Unknown error' 
          });
        }
      });

      // Small delay between batches to avoid overwhelming the server
      if (i + batchSize < notes.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log('✅ Legacy bulk sync complete:', {
      totalNotes: notes.length,
      updated: results.updatedNotes.length,
      conflicts: results.conflicts.length,
      errors: results.errors.length
    });

    return results;
  }

  // Check a single note for updates
  async checkNoteForUpdates(note, currentUser) {
    try {
      console.log(`🔍 Checking note ${note.id} for updates since ${note.updatedAt}`);
      
      const response = await api.get(`/api/notes/${note.id}/updates?since=${note.updatedAt}`);
      const { content, title, updatedAt, lastEditor } = response.data;

      console.log(`🔍 Server response for note ${note.id}:`, {
        hasContent: !!content,
        contentLength: content?.length,
        contentPreview: content?.substring(0, 100) + '...',
        hasTitle: !!title,
        title: title,
        serverUpdatedAt: updatedAt,
        noteUpdatedAt: note.updatedAt,
        lastEditor: lastEditor?.name || 'Unknown'
      });

      // No updates if server timestamp is same or older
      if (!updatedAt || new Date(updatedAt).getTime() <= new Date(note.updatedAt).getTime()) {
        console.log(`⭐ No updates for note ${note.id} - server time: ${updatedAt}, note time: ${note.updatedAt}`);
        return { hasUpdates: false };
      }

      // Skip if this was our own update (within last 10 seconds)
      if (lastEditor?.id === currentUser?.id) {
        const timeSinceEdit = Date.now() - new Date(updatedAt).getTime();
        if (timeSinceEdit < 10000) {
          console.log(`⭐ Skipping own recent update for note ${note.id} (${timeSinceEdit}ms ago)`);
          return { hasUpdates: false };
        }
      }

      console.log(`📥 Found updates for note ${note.id}:`, {
        oldUpdatedAt: note.updatedAt,
        newUpdatedAt: updatedAt,
        lastEditor: lastEditor?.name || 'Unknown',
        contentChanged: note.content !== content,
        titleChanged: note.title !== title
      });

      // Check if there might be local changes that would conflict
      const hasLocalChanges = this.pendingNotes.has(note.id);

      if (hasLocalChanges) {
        console.log(`⚠️ Potential conflict detected for note ${note.id}`);
        return {
          hasUpdates: true,
          conflict: {
            localNote: note,
            remoteContent: content,
            remoteTitle: title,
            remoteUpdatedAt: updatedAt,
            lastEditor
          }
        };
      }

      // No conflict - return updated note
      const updatedNote = {
        ...note,
        title: title !== undefined ? title : note.title,
        content: content !== undefined ? content : note.content,
        updatedAt,
        lastEditedBy: lastEditor?.id,
        lastEditorName: lastEditor?.name,
        lastEditorAvatar: lastEditor?.avatar
      };
      
      console.log(`✅ Returning updated note ${note.id}:`, {
        titleChanged: note.title !== updatedNote.title,
        contentChanged: note.content !== updatedNote.content,
        newContentLength: updatedNote.content?.length
      });
      
      return {
        hasUpdates: true,
        updatedNote
      };

    } catch (error) {
      if (error.response?.status === 429) {
        console.log(`⏸️ Rate limited checking note ${note.id}`);
        return { hasUpdates: false };
      }
      
      console.error(`❌ Error checking note ${note.id}:`, error);
      return { hasUpdates: false, error: error.message };
    }
  }

  // Mark a note as having pending local changes
  markNotePending(noteId) {
    this.pendingNotes.add(noteId);
    console.log(`📝 Marked note ${noteId} as having pending changes`);
  }

  // Clear pending status for a note (after successful save)
  clearNotePending(noteId) {
    this.pendingNotes.delete(noteId);
    console.log(`✅ Cleared pending status for note ${noteId}`);
  }

  // Get sync statistics
  getSyncStats() {
    return {
      lastGlobalSync: this.lastGlobalSync,
      syncInProgress: this.syncInProgress,
      pendingNotesCount: this.pendingNotes.size,
      pendingNotes: Array.from(this.pendingNotes)
    };
  }
}

// Export singleton instance
export const syncService = new SyncService();

// =============================================================================
// CONFLICT RESOLUTION STRATEGIES - All go in this same file
// =============================================================================

export const ConflictResolutionStrategies = {
  // Strategy 1: Smart merge for lists (like shopping lists)
  smartMergeList: (localContent, remoteContent) => {
    try {
      // Extract list items from both versions
      const localItems = extractListItems(localContent);
      const remoteItems = extractListItems(remoteContent);
      
      // Find unique items from both lists
      const allItems = new Set([...localItems, ...remoteItems]);
      
      // Rebuild as a clean list
      const mergedContent = Array.from(allItems)
        .filter(item => item.trim()) // Remove empty items
        .map(item => `* ${item}`)
        .join('\n');
      
      console.log('🔄 Smart list merge:', {
        localItems: localItems.length,
        remoteItems: remoteItems.length,
        mergedItems: allItems.size
      });
      
      return mergedContent;
    } catch (error) {
      console.error('❌ Smart merge failed, falling back to simple merge');
      return ConflictResolutionStrategies.simpleMerge(localContent, remoteContent);
    }
  },

  // Strategy 2: Time-based merge (newer wins for each paragraph)
  timeMerge: (localContent, remoteContent, remoteTimestamp) => {
    try {
      // For now, just use the newer content
      // In a real implementation, you'd track paragraph-level timestamps
      const localTime = Date.now() - 30000; // Assume local changes are recent
      const remoteTime = new Date(remoteTimestamp).getTime();
      
      if (remoteTime > localTime) {
        console.log('🕐 Using remote content (newer)');
        return remoteContent;
      } else {
        console.log('🕐 Using local content (newer)');
        return localContent;
      }
    } catch (error) {
      return remoteContent; // Default to remote
    }
  },

  // Strategy 3: Simple append (safest but can create duplicates)
  simpleMerge: (localContent, remoteContent) => {
    return `${localContent}\n\n--- Remote changes ---\n${remoteContent}`;
  },

  // Strategy 4: Intelligent merge based on content type
  intelligentMerge: (localContent, remoteContent, context = {}) => {
    // Detect content type
    const isShoppingList = /^\s*[\*\-\+]\s+/m.test(localContent) && /^\s*[\*\-\+]\s+/m.test(remoteContent);
    const isTodoList = /^\s*[\*\-\+]\s*\[[\sx]\]/m.test(localContent);
    
    if (isShoppingList || isTodoList) {
      return ConflictResolutionStrategies.smartMergeList(localContent, remoteContent);
    } else {
      return ConflictResolutionStrategies.timeMerge(localContent, remoteContent, context.remoteTimestamp);
    }
  }
};

// =============================================================================
// HELPER FUNCTIONS - Also go in this same file
// =============================================================================

// Helper function to extract list items
function extractListItems(content) {
  const lines = content.split('\n');
  const items = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Match bullet points: *, -, +, or checkbox items
    const match = trimmed.match(/^[\*\-\+]\s*(?:\[[\sx]\]\s*)?(.+)$/);
    if (match) {
      const item = match[1].trim();
      if (item && !items.includes(item)) {
        items.push(item);
      }
    }
  }
  
  return items;
}
