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
  async storeNotes(notes, userId) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes'], 'readwrite');
    const store = transaction.objectStore('notes');

    const promises = notes.map(note => {
      const noteWithUserId = { ...note, userId, cachedAt: Date.now() };
      return store.put(noteWithUserId);
    });

    await Promise.all(promises);
    return transaction.complete;
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

  // Store single note
  async storeNote(note, userId) {
    const db = await this.ensureDB();
    const transaction = db.transaction(['notes'], 'readwrite');
    const store = transaction.objectStore('notes');

    const noteWithUserId = { ...note, userId, cachedAt: Date.now() };
    await store.put(noteWithUserId);
    return transaction.complete;
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