// Offline storage using IndexedDB for reliable local caching
class OfflineStorageManager {
  constructor() {
    this.dbName = 'MaterialNotesDB';
    this.version = 1;
    this.db = null;
    this.initDB();
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Notes store
        if (!db.objectStoreNames.contains('notes')) {
          const notesStore = db.createObjectStore('notes', { keyPath: 'id' });
          notesStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          notesStore.createIndex('userId', 'userId', { unique: false });
        }

        // Pending changes store (for offline edits)
        if (!db.objectStoreNames.contains('pendingChanges')) {
          const changesStore = db.createObjectStore('pendingChanges', { keyPath: 'id' });
          changesStore.createIndex('timestamp', 'timestamp', { unique: false });
          changesStore.createIndex('noteId', 'noteId', { unique: false });
        }

        // User data store
        if (!db.objectStoreNames.contains('userData')) {
          db.createObjectStore('userData', { keyPath: 'key' });
        }

        // App metadata store
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      };
    });
  }

  async ensureDB() {
    if (!this.db) {
      await this.initDB();
    }
    return this.db;
  }

  // Store notes locally
  async storeNotes(notes, userId, options = {}) {
    // For bulk operations, use individual storeNote calls to handle originalHash properly
    try {
      const promises = notes.map(note => this.storeNote(note, userId, options));
      await Promise.all(promises);
      return true;
    } catch (error) {
      console.error('❌ Bulk store notes failed:', error);
      throw error;
    }
  }

  // Get cached notes
  async getCachedNotes(userId) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes'], 'readonly');
    const store = transaction.objectStore('notes');
    const index = store.index('userId');

    return new Promise((resolve, reject) => {
      const request = index.getAll(userId);
      request.onsuccess = () => {
        const notes = request.result.sort((a, b) => 
          new Date(b.updatedAt) - new Date(a.updatedAt)
        );
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Store single note with original hash for conflict detection
  async storeNote(note, userId, options = {}) {
    const db = await this.ensureDB();
    
    // CRITICAL: Get existing note BEFORE starting transaction to avoid transaction conflicts
    const existingNote = await this.getCachedNote(note.id);
    let originalHash;
    
    // If this is a server update (fromServer: true), always update the originalHash
    // to reflect the new server baseline
    if (options.fromServer && note.contentHash) {
      originalHash = note.contentHash;
      if (process.env.NODE_ENV === 'development') {
        console.log(`🔄 Updating originalHash from server for note ${note.id}: ${originalHash}`);
      }
    } else if (existingNote && existingNote.originalHash) {
      // We already have an original hash - preserve it for local changes
      originalHash = existingNote.originalHash;
      if (process.env.NODE_ENV === 'development') {
        console.log(`🔒 Preserving existing originalHash for note ${note.id}: ${originalHash}`);
      }
    } else {
      // First time caching this note - establish the baseline hash
      originalHash = note.contentHash || await this.generateContentHash(note.title, note.content);
      if (process.env.NODE_ENV === 'development') {
        console.log(`🆕 Setting new originalHash for note ${note.id}: ${originalHash}`);
      }
    }
    
    // Now start a fresh transaction for the actual storage operation
    const transaction = db.transaction(['notes'], 'readwrite');
    const store = transaction.objectStore('notes');
    
    const noteWithUserId = { 
      ...note, 
      userId, 
      cachedAt: Date.now(),
      originalHash // Baseline hash from server when first cached - never changes during offline edits
    };
    
    try {
      await store.put(noteWithUserId);
      await transaction.complete;
      return true;
    } catch (error) {
      console.error('❌ IndexedDB transaction failed:', error);
      throw error;
    }
  }

  // Normalize content to prevent hash differences from whitespace/formatting (matches backend)
  normalizeContent(content) {
    if (!content) return '';
    return content
      .replace(/\r\n/g, '\n')                    // Normalize line endings (Windows)
      .replace(/\r/g, '\n')                     // Handle old Mac line endings  
      .replace(/\s+$/gm, '')                    // Remove trailing whitespace from each line
      .replace(/(<p><\/p>)+/g, '')              // Remove empty paragraphs anywhere (not just end)
      .replace(/(<p><br><\/p>)+/g, '')          // Remove paragraphs containing only <br>
      .replace(/(<p>\s*<\/p>)+/g, '')           // Remove paragraphs with only whitespace
      .replace(/>\s+</g, '><')                  // Remove whitespace between tags
      .replace(/\s+/g, ' ')                     // Normalize multiple spaces to single space
      .trim();                                  // Remove leading/trailing whitespace
  }

  // Generate content hash for change detection (matches backend normalization)
  async generateContentHash(title, content) {
    // CRITICAL: Normalize content before hashing to match backend behavior
    const normalizedContent = this.normalizeContent(content || '');
    const normalizedTitle = (title || '').trim();
    const combined = `${normalizedTitle}|||${normalizedContent}`;
    
    // Use Web Crypto API with SHA-256
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.substring(0, 8);
  }

  // Get single cached note
  async getCachedNote(noteId) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes'], 'readonly');
    const store = transaction.objectStore('notes');

    return new Promise((resolve, reject) => {
      const request = store.get(noteId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Store pending changes for offline edits
  async storePendingChange(change) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['pendingChanges'], 'readwrite');
    const store = transaction.objectStore('pendingChanges');

    const changeWithId = {
      ...change,
      id: `${change.noteId}-${Date.now()}`,
      timestamp: Date.now()
    };

    await store.put(changeWithId);
    return transaction.complete;
  }

  // Get all pending changes
  async getPendingChanges() {
    const db = await this.ensureDB();
    const transaction = db.transaction(['pendingChanges'], 'readonly');
    const store = transaction.objectStore('pendingChanges');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const changes = request.result.sort((a, b) => a.timestamp - b.timestamp);
        resolve(changes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Remove pending change after successful sync
  async removePendingChange(changeId) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['pendingChanges'], 'readwrite');
    const store = transaction.objectStore('pendingChanges');

    await store.delete(changeId);
    return transaction.complete;
  }

  // Clear all pending changes
  async clearPendingChanges() {
    const db = await this.ensureDB();
    const transaction = db.transaction(['pendingChanges'], 'readwrite');
    const store = transaction.objectStore('pendingChanges');

    await store.clear();
    return transaction.complete;
  }

  // Store user data
  async storeUserData(key, data) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['userData'], 'readwrite');
    const store = transaction.objectStore('userData');

    await store.put({ key, data, timestamp: Date.now() });
    return transaction.complete;
  }

  // Get user data
  async getUserData(key) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['userData'], 'readonly');
    const store = transaction.objectStore('userData');

    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.data : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Store app metadata
  async storeMetadata(key, value) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['metadata'], 'readwrite');
    const store = transaction.objectStore('metadata');

    await store.put({ key, value, timestamp: Date.now() });
    return transaction.complete;
  }

  // Get app metadata
  async getMetadata(key) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['metadata'], 'readonly');
    const store = transaction.objectStore('metadata');

    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.value : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Delete note from cache
  async deleteCachedNote(noteId) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes'], 'readwrite');
    const store = transaction.objectStore('notes');

    await store.delete(noteId);
    return transaction.complete;
  }

  // Check if note has been modified locally since last sync
  async checkForOfflineChanges(note) {
    const currentHash = await this.generateContentHash(note.title, note.content);
    const originalHash = note.originalHash;
    
    if (!originalHash) {
      // No original hash stored, treat as new note
      return { hasChanges: false, isNewNote: true };
    }
    
    const hasLocalChanges = currentHash !== originalHash;
    
    return {
      hasChanges: hasLocalChanges,
      currentHash,
      originalHash,
      isNewNote: false
    };
  }

  // Update note's original hash ONLY after successful server sync
  async updateOriginalHashAfterSync(noteId, serverHash, serverContent, serverTitle) {
    console.log(`🔄 Updating originalHash after successful sync for note ${noteId}: ${serverHash}`);
    const note = await this.getCachedNote(noteId);
    if (note) {
      // Update the note with server data and new original hash
      const updatedNote = {
        ...note,
        title: serverTitle !== undefined ? serverTitle : note.title,
        content: serverContent !== undefined ? serverContent : note.content,
        originalHash: serverHash, // This becomes the new baseline after successful sync
        lastSyncedAt: Date.now()
      };
      
      // Use direct storage bypass to avoid the originalHash preservation logic
      const db = await this.ensureDB();
      const transaction = db.transaction(['notes'], 'readwrite');
      const store = transaction.objectStore('notes');
      
      try {
        await store.put(updatedNote);
        await transaction.complete;
        return true;
      } catch (error) {
        console.error('❌ IndexedDB update after sync failed:', error);
        throw error;
      }
    }
  }

  // CRITICAL: Check if cached note has offline changes that need preservation
  async hasOfflineChanges(noteId) {
    const cachedNote = await this.getCachedNote(noteId);
    if (!cachedNote || !cachedNote.originalHash) {
      return false; // No cached note or baseline hash
    }
    
    // Generate current hash of cached content
    const cachedHash = await this.generateContentHash(cachedNote.title, cachedNote.content);
    const hasLocalChanges = cachedHash !== cachedNote.originalHash;
    
    console.log(`🔍 Offline change check for note ${noteId}:`, {
      cachedHash: cachedHash.substring(0, 8),
      originalHash: cachedNote.originalHash?.substring(0, 8),
      hasLocalChanges
    });
    
    return hasLocalChanges;
  }
  
  // Legacy method - kept for compatibility but simplified
  async shouldDeferToServer(noteId, serverNote) {
    const hasChanges = await this.hasOfflineChanges(noteId);
    return !hasChanges; // Defer to server if no local changes
  }

  // Get cache statistics
  async getCacheStats() {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes', 'pendingChanges'], 'readonly');
    
    const notesCount = await this.getStoreCount(transaction.objectStore('notes'));
    const pendingCount = await this.getStoreCount(transaction.objectStore('pendingChanges'));
    
    return {
      cachedNotes: notesCount,
      pendingChanges: pendingCount,
      lastSync: await this.getMetadata('lastSync')
    };
  }

  async getStoreCount(store) {
    return new Promise((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Clear all cached data
  async clearAllCache() {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes', 'pendingChanges', 'userData', 'metadata'], 'readwrite');
    
    await Promise.all([
      transaction.objectStore('notes').clear(),
      transaction.objectStore('pendingChanges').clear(),
      transaction.objectStore('userData').clear(),
      transaction.objectStore('metadata').clear()
    ]);
    
    return transaction.complete;
  }
}

// Singleton instance
const offlineStorage = new OfflineStorageManager();

export default offlineStorage;