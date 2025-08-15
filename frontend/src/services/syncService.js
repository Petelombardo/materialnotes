// src/services/syncService.js - Complete file
import api from '../utils/api';

class SyncService {
  constructor() {
    this.lastGlobalSync = null;
    this.syncInProgress = false;
    this.pendingNotes = new Set();
  }

  // Check all notes for updates when app resumes
  async syncAllNotes(notes, currentUser) {
    if (this.syncInProgress || !notes || notes.length === 0) {
      console.log('⭐ Skipping sync - already in progress or no notes');
      return { updatedNotes: [], conflicts: [] };
    }

    this.syncInProgress = true;
    console.log(`🔄 Starting bulk sync for ${notes.length} notes`);

    try {
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

      console.log('✅ Bulk sync complete:', {
        totalNotes: notes.length,
        updated: results.updatedNotes.length,
        conflicts: results.conflicts.length,
        errors: results.errors.length
      });

      this.lastGlobalSync = Date.now();
      return results;

    } catch (error) {
      console.error('❌ Bulk sync failed:', error);
      return { updatedNotes: [], conflicts: [], errors: [{ error: error.message }] };
    } finally {
      this.syncInProgress = false;
    }
  }

  // Check a single note for updates
  async checkNoteForUpdates(note, currentUser) {
    try {
      console.log(`🔍 Checking note ${note.id} for updates since ${note.updatedAt}`);
      
      const response = await api.get(`/api/notes/${note.id}/updates?since=${note.updatedAt}`);
      const { content, title, updatedAt, lastEditor } = response.data;

      // No updates if server timestamp is same or older
      if (!updatedAt || new Date(updatedAt).getTime() <= new Date(note.updatedAt).getTime()) {
        console.log(`⭐ No updates for note ${note.id}`);
        return { hasUpdates: false };
      }

      // Skip if this was our own update (within last 10 seconds)
      if (lastEditor?.id === currentUser?.id) {
        const timeSinceEdit = Date.now() - new Date(updatedAt).getTime();
        if (timeSinceEdit < 10000) {
          console.log(`⭐ Skipping own recent update for note ${note.id}`);
          return { hasUpdates: false };
        }
      }

      console.log(`📥 Found updates for note ${note.id}:`, {
        oldUpdatedAt: note.updatedAt,
        newUpdatedAt: updatedAt,
        lastEditor: lastEditor?.name || 'Unknown'
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
      return {
        hasUpdates: true,
        updatedNote: {
          ...note,
          title: title || note.title,
          content: content || note.content,
          updatedAt,
          lastEditedBy: lastEditor?.id,
          lastEditorName: lastEditor?.name,
          lastEditorAvatar: lastEditor?.avatar
        }
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