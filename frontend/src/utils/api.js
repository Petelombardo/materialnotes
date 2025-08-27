import axios from 'axios';
import offlineStorage from './offlineStorage';

class OfflineCapableAPI {
  constructor() {
    // Use the correct port (3002) for both development and production
   // this.baseURL = process.env.NODE_ENV === 'production' 
   //   ? '' 
   //   : 'http://localhost:3002';
//   this.baseURL = process.env.REACT_APP_API_URL || '';

    this.baseURL = process.env.NODE_ENV === 'production' 
      ? '' // Use relative URLs in production (same domain)
      : 'http://localhost:3002';

    // Start with conservative online detection
    this.isOnline = navigator.onLine;
    this.syncInProgress = false;
    this.pendingSyncs = [];
    this.connectivityCheckInterval = null;
    this.failedRequestCount = 0;
    this.consecutiveFailures = 0;
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1 second
    this.lastConnectivityTest = 0;
    this.connectivityTestDebounce = 5000; // Don't test more than once every 5 seconds
    
    console.log('API Manager initialized:', { 
      isOnline: this.isOnline, 
      userAgent: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop' 
    });
    
    // Create axios instance with better timeout handling
    this.api = axios.create({
      baseURL: this.baseURL,
      withCredentials: true,
      timeout: 8000, // Reduced to 8 seconds for local development
    });

    // Add auth token to requests
    this.api.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem('token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Improved response interceptor with less aggressive offline detection
    this.api.interceptors.response.use(
      (response) => {
        // Successful response - we're definitely online
        if (!this.isOnline) {
          console.log('Successful API response - switching to online mode');
          this.setOnlineStatus(true);
        }
        // Reset failure counters on success
        this.failedRequestCount = 0;
        this.consecutiveFailures = 0;
        return response;
      },
      (error) => {
        console.log('API Response Error:', error.response?.status, error.code, error.message);
        
        // Handle auth errors
        if (error.response?.status === 401) {
          console.log('401 Unauthorized - clearing auth');
          localStorage.removeItem('token');
          window.location.reload();
          return Promise.reject(error);
        }
        
        // Only detect network errors for actual network issues, not server errors
        if (this.isActualNetworkError(error)) {
          this.failedRequestCount++;
          this.consecutiveFailures++;
          
          if (error.response?.status === 429) {
            console.log(`Rate limiting detected (429) - treating as network error (${this.consecutiveFailures} consecutive)`);
          } else {
            console.log(`Network error detected (${this.consecutiveFailures} consecutive):`, error.message);
          }
          
          // Switch to offline after multiple consecutive failures OR clear network/server errors
          const isClearNetworkFailure = error.code === 'ECONNABORTED' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND';
          const isClearServerFailure = error.response?.status === 429 || error.response?.status === 502 || error.response?.status === 503;
          const shouldGoOffline = (this.consecutiveFailures >= 2) || isClearNetworkFailure || isClearServerFailure;
          
          if (shouldGoOffline) {
            if (isClearServerFailure) {
              console.log(`Switching to offline mode due to server error: ${error.response?.status}`);
            } else {
              console.log('Switching to offline mode due to network errors');
            }
            this.setOnlineStatus(false);
          }
        } else {
          // Reset consecutive failures for non-network errors (like 500, 404, etc.)
          this.consecutiveFailures = 0;
        }
        
        return Promise.reject(error);
      }
    );

    // Listen for browser online/offline events (as backup)
    window.addEventListener('online', () => {
      console.log('Browser online event detected');
      this.handleBrowserOnline();
    });

    window.addEventListener('offline', () => {
      console.log('Browser offline event detected');
      // Only go offline immediately if browser says so and we have recent failures
      if (this.consecutiveFailures > 0) {
        this.setOnlineStatus(false);
      }
    });

    // Start connectivity monitoring (less aggressive)
    this.startConnectivityMonitoring();
    
    // Expose API service globally for WebSocket integration
    if (typeof window !== 'undefined') {
      window.apiService = this;
    }
    
    // Test connectivity on startup with a small delay
    setTimeout(() => {
      this.testConnectivity();
    }, 2000);
  }

  // Set online status and dispatch events - ENHANCED to sync with WebSocket
  setOnlineStatus(isOnline, reason = 'api') {
    const wasOnline = this.isOnline;
    this.isOnline = isOnline;
    
    // If WebSocket service exists and reports different state, sync with it
    if (typeof window !== 'undefined' && window.websocketService) {
      const wsConnected = window.websocketService.isConnected && window.websocketService.isConnected();
      
      // If WebSocket is connected but API thinks we're offline, trust WebSocket for some operations
      if (wsConnected && !isOnline && reason === 'api') {
        console.log('🔄 WebSocket connected but API offline - using hybrid mode');
        this.isOnline = true; // Allow basic operations
        this.hybridMode = true; // Track this special state
      } else {
        this.hybridMode = false;
      }
    }
    
    if (wasOnline !== this.isOnline) {
      console.log(`🔗 API connectivity: ${this.isOnline ? 'online' : 'offline'} (${reason})${this.hybridMode ? ' [hybrid]' : ''}`);
      
      if (this.isOnline) {
        this.failedRequestCount = 0;
        this.consecutiveFailures = 0;
        this.syncPendingChanges();
        this.dispatchEvent('online');
      } else {
        this.dispatchEvent('offline');
      }
    }
  }

  // Handle browser online event with verification
  async handleBrowserOnline() {
    console.log('Browser reports online - verifying connectivity...');
    // Debounce rapid online/offline events
    const now = Date.now();
    if (now - this.lastConnectivityTest < this.connectivityTestDebounce) {
      console.log('Connectivity test debounced');
      return;
    }
    
    const isActuallyOnline = await this.testConnectivity();
    if (isActuallyOnline) {
      this.setOnlineStatus(true);
    }
  }

  // More conservative connectivity test
  async testConnectivity(force = false) {
    // Debounce connectivity tests unless forced
    const now = Date.now();
    if (!force && now - this.lastConnectivityTest < this.connectivityTestDebounce) {
      console.log('Connectivity test debounced, using cached result');
      return this.isOnline;
    }
    
    this.lastConnectivityTest = now;
    
    if (!navigator.onLine) {
      console.log('Browser reports offline, skipping connectivity test');
      this.setOnlineStatus(false);
      return false;
    }
    
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // Reduced timeout for local dev
      
      // Use backend API endpoint that definitely requires the backend
      const healthUrl = this.baseURL || '';
      const token = localStorage.getItem('token');
      const headers = {
        'Cache-Control': 'no-cache'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const response = await fetch(healthUrl + '/api/notes', { 
        method: 'HEAD', // Just check if endpoint exists, don't need data
        headers,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // 401 means backend is running but not authenticated - still "online"
      // 200, 401, 403, etc. all mean backend is responding
      const isOnline = response.status < 500;
      console.log('Connectivity test result:', { 
        ok: response.ok, 
        status: response.status,
        isOnline 
      });
      
      if (isOnline) {
        this.setOnlineStatus(true);
      } else {
        // Don't immediately go offline on a single failed health check
        // unless we already have other indicators
        if (this.consecutiveFailures > 1 || !navigator.onLine) {
          this.setOnlineStatus(false);
        }
      }
      
      return isOnline;
      
    } catch (error) {
      console.log('Connectivity test failed:', error.name, error.message);
      
      // Only go offline for clear network failures or if browser also says offline
      const isClearFailure = error.name === 'AbortError' || error.name === 'TypeError';
      if (isClearFailure || !navigator.onLine) {
        this.setOnlineStatus(false);
        return false;
      }
      
      // For other errors, don't change status immediately
      console.log('Connectivity test error but not switching to offline yet');
      return this.isOnline;
    }
  }

  // Start less aggressive connectivity monitoring
  startConnectivityMonitoring() {
    // Check connectivity every 60 seconds when online, every 20 seconds when offline
    const scheduleNextCheck = () => {
      const interval = this.isOnline ? 60000 : 20000; // Increased intervals
      this.connectivityCheckInterval = setTimeout(async () => {
        // Only run automatic tests if we haven't tested recently
        const timeSinceLastTest = Date.now() - this.lastConnectivityTest;
        if (timeSinceLastTest >= this.connectivityTestDebounce) {
          await this.testConnectivity();
        }
        scheduleNextCheck();
      }, interval);
    };
    
    scheduleNextCheck();
  }

  // Stop connectivity monitoring
  stopConnectivityMonitoring() {
    if (this.connectivityCheckInterval) {
      clearTimeout(this.connectivityCheckInterval);
      this.connectivityCheckInterval = null;
    }
  }

  // More precise network error detection
  isActualNetworkError(error) {
    // No response usually means network issue
    if (!error.response) {
      return true;
    }
    
    // Check for various network error indicators
    return (
      error.code === 'NETWORK_ERROR' || 
      error.code === 'ECONNABORTED' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.message.includes('Network Error') ||
      error.message.includes('net::ERR_') ||
      error.message.includes('Failed to fetch') ||
      // Add back server errors that indicate backend is down or unavailable
      (error.response && (error.response.status === 429 || error.response.status === 502 || error.response.status === 503))
    );
  }

  // Improved network error detection for public use
  isNetworkError(error) {
    return this.isActualNetworkError(error);
  }

  // Retry wrapper for API requests
  async retryRequest(requestFn, maxRetries = this.maxRetries) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await requestFn();
        return result;
      } catch (error) {
        lastError = error;
        
        if (!this.isActualNetworkError(error) || attempt === maxRetries) {
          throw error;
        }
        
        console.log(`Request attempt ${attempt} failed, retrying in ${this.retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * attempt));
      }
    }
    
    throw lastError;
  }

  // Event system for components to listen to connectivity changes
  addEventListener(event, callback) {
    document.addEventListener(`api-${event}`, callback);
  }

  removeEventListener(event, callback) {
    document.removeEventListener(`api-${event}`, callback);
  }

  dispatchEvent(event, data = {}) {
    const customEvent = new CustomEvent(`api-${event}`, { detail: data });
    document.dispatchEvent(customEvent);
  }

// Get notes - works offline with retry logic
  async get(url) {
    if (url === '/api/notes') {
      return this.getNotes();
    } else if (url.match(/^\/api\/notes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      // Only match single note URLs with UUID format like /api/notes/{uuid}
      const noteId = url.split('/').pop();
      return this.getNote(noteId);
    } else {
      // For other endpoints (including collaboration endpoints), try online first with retry
      if (this.isOnline) {
        try {
          return await this.retryRequest(() => this.api.get(url));
        } catch (error) {
          if (this.isActualNetworkError(error)) {
            this.consecutiveFailures++;
            // Don't immediately go offline, let the interceptor handle it
          }
          throw error;
        }
      } else {
        throw new Error('Offline: This operation requires internet connection');
      }
    }
  }

  // Get all notes with improved error handling
  async getNotes() {
    const currentUser = await this.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      if (this.isOnline) {
        // Try to fetch from server with retry
        const response = await this.retryRequest(() => this.api.get('/api/notes'));
        const notes = response.data;
        
        // CRITICAL: Handle offline changes properly during reconnection
        console.log('🔄 Processing server notes with offline change detection');
        
        for (const note of notes) {
          // Get current cached version before any updates
          const cachedNote = await offlineStorage.getCachedNote(note.id);
          
          if (!cachedNote) {
            // No cached version - safe to store server version
            await offlineStorage.storeNote(note, currentUser.id, { fromServer: true });
            continue;
          }
          
          // Check for local changes by comparing cached content to original baseline
          const cachedHash = await offlineStorage.generateContentHash(cachedNote.title, cachedNote.content);
          const originalHash = cachedNote.originalHash;
          const hasLocalChanges = cachedHash !== originalHash;
          
          if (process.env.NODE_ENV === 'development') {
            console.log(`🔍 Offline change check for note ${note.id}:`, {
              cachedHash: cachedHash?.substring(0, 8),
              originalHash: originalHash?.substring(0, 8), 
              serverHash: note.contentHash?.substring(0, 8),
              hasLocalChanges,
              serverNewer: new Date(note.updatedAt) > new Date(cachedNote.updatedAt)
            });
          }
          
          if (!hasLocalChanges) {
            // No local changes - safe to update with server version
            await offlineStorage.storeNote(note, currentUser.id, { fromServer: true });
            if (process.env.NODE_ENV === 'development') {
              console.log(`✅ No local changes for note ${note.id}, accepting server version`);
            }
          } else {
            // Has local changes - preserve them and trigger conflict resolution
            console.log(`⚠️ Local changes detected for note ${note.id}, preserving cached version`);
            
            // Update cached note with server metadata but keep local content
            const preservedNote = {
              ...cachedNote,
              // Keep local content changes
              title: cachedNote.title,
              content: cachedNote.content,
              // Update server metadata
              updatedAt: note.updatedAt,
              serverVersion: {
                title: note.title,
                content: note.content,
                contentHash: note.contentHash,
                updatedAt: note.updatedAt
              },
              needsConflictResolution: true
            };
            
            // Store with fromServer: false to preserve originalHash
            await offlineStorage.storeNote(preservedNote, currentUser.id, { fromServer: false });
            
            // Trigger conflict resolution in the UI
            this.dispatchEvent('offline-conflict-detected', {
              noteId: note.id,
              localVersion: cachedNote,
              serverVersion: note
            });
          }
        }
        await offlineStorage.storeMetadata('lastSync', Date.now());
        
        return response;
      } else {
        // Return cached notes
        const cachedNotes = await offlineStorage.getCachedNotes(currentUser.id);
        return { data: cachedNotes || [] };
      }
    } catch (error) {
      if (this.isActualNetworkError(error)) {
        // Don't immediately set offline, let the response interceptor handle it
        
        // Return cached notes as fallback
        const cachedNotes = await offlineStorage.getCachedNotes(currentUser.id);
        return { data: cachedNotes || [] };
      }
      throw error;
    }
  }

  // Get single note with retry
  async getNote(noteId) {
    try {
      if (this.isOnline) {
        // Try to fetch from server with retry
        const response = await this.retryRequest(() => this.api.get(`/api/notes/${noteId}`));
        const note = response.data;
        
        // Cache the note locally (from server)
        const currentUser = await this.getCurrentUser();
        if (currentUser) {
          await offlineStorage.storeNote(note, currentUser.id, { fromServer: true });
        }
        
        return response;
      } else {
        // Return cached note
        const cachedNote = await offlineStorage.getCachedNote(noteId);
        if (cachedNote) {
          return { data: cachedNote };
        } else {
          throw new Error('Note not available offline');
        }
      }
    } catch (error) {
      if (this.isActualNetworkError(error)) {
        // Return cached note as fallback
        const cachedNote = await offlineStorage.getCachedNote(noteId);
        if (cachedNote) {
          return { data: cachedNote };
        }
      }
      throw error;
    }
  }

  // Create note - works offline with retry
  async post(url, data) {
    if (url === '/api/notes') {
      return this.createNote(data);
    } else {
      // For other endpoints, require online connection with retry
      if (this.isOnline) {
        try {
          return await this.retryRequest(() => this.api.post(url, data));
        } catch (error) {
          if (this.isActualNetworkError(error)) {
            this.consecutiveFailures++;
          }
          throw error;
        }
      } else {
        throw new Error('Offline: This operation requires internet connection');
      }
    }
  }

  // Create note with improved error handling
  async createNote(data) {
    const currentUser = await this.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    if (this.isOnline) {
      try {
        // Create note online with retry
        const response = await this.retryRequest(() => this.api.post('/api/notes', data));
        const note = response.data;
        
        // Cache the new note (from server)
        await offlineStorage.storeNote(note, currentUser.id, { fromServer: true });
        
        return response;
      } catch (error) {
        if (this.isActualNetworkError(error)) {
          // Fall through to offline creation
        } else {
          throw error;
        }
      }
    }

    // Create note offline (same as before)
    const noteId = 'offline-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const now = new Date().toISOString();
    
    const offlineNote = {
      id: noteId,
      title: data.title || 'Untitled',
      content: data.content || '',
      createdAt: now,
      updatedAt: now,
      shared: false,
      permission: 'edit',
      offline: true,
      pendingSync: true
    };

    // Store note locally
    await offlineStorage.storeNote(offlineNote, currentUser.id);
    
    // Queue for sync when online
    await offlineStorage.storePendingChange({
      type: 'create',
      noteId: noteId,
      data: data,
      offline: true
    });

    this.dispatchEvent('offline-change', { type: 'create', noteId });

    return { data: offlineNote };
  }

  // Update note - works offline with retry
  async put(url, data) {
    const match = url.match(/^\/api\/notes\/(.+)$/);
    if (match) {
      const noteId = match[1];
      return this.updateNote(noteId, data);
    } else {
      // For other endpoints, require online connection with retry
      if (this.isOnline) {
        try {
          return await this.retryRequest(() => this.api.put(url, data));
        } catch (error) {
          if (this.isActualNetworkError(error)) {
            this.consecutiveFailures++;
          }
          throw error;
        }
      } else {
        throw new Error('Offline: This operation requires internet connection');
      }
    }
  }

  // Update note with improved error handling
  async updateNote(noteId, data) {
    const currentUser = await this.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    // Get current note from cache
    let currentNote = await offlineStorage.getCachedNote(noteId);
    
    if (this.isOnline && !noteId.startsWith('offline-')) {
      try {
        // Update note online with retry
        const response = await this.retryRequest(() => this.api.put(`/api/notes/${noteId}`, data));
        const note = response.data;
        
        // Update cache (from server)
        await offlineStorage.storeNote(note, currentUser.id, { fromServer: true });
        
        return response;
      } catch (error) {
        if (this.isActualNetworkError(error)) {
          // Fall through to offline update
        } else {
          throw error;
        }
      }
    }

    // Update note offline (same as before)
    if (!currentNote) {
      throw new Error('Note not found in cache');
    }

    const now = new Date().toISOString();
    const updatedNote = {
      ...currentNote,
      ...data,
      updatedAt: now,
      offline: true,
      pendingSync: true
    };

    // Store updated note locally
    await offlineStorage.storeNote(updatedNote, currentUser.id);
    
    // Queue for sync when online
    await offlineStorage.storePendingChange({
      type: 'update',
      noteId: noteId,
      data: data,
      offline: true
    });

    this.dispatchEvent('offline-change', { type: 'update', noteId });

    return { data: updatedNote };
  }

  // Delete note - works offline with retry
  async delete(url) {
    const match = url.match(/^\/api\/notes\/(.+)$/);
    if (match) {
      const noteId = match[1];
      return this.deleteNote(noteId);
    } else {
      // For other endpoints, require online connection with retry
      if (this.isOnline) {
        try {
          return await this.retryRequest(() => this.api.delete(url));
        } catch (error) {
          if (this.isActualNetworkError(error)) {
            this.consecutiveFailures++;
          }
          throw error;
        }
      } else {
        throw new Error('Offline: This operation requires internet connection');
      }
    }
  }

  // Delete note with improved error handling
  async deleteNote(noteId) {
    if (this.isOnline && !noteId.startsWith('offline-')) {
      try {
        // Delete note online with retry
        const response = await this.retryRequest(() => this.api.delete(`/api/notes/${noteId}`));
        
        // Remove from cache
        await offlineStorage.deleteCachedNote(noteId);
        
        return response;
      } catch (error) {
        if (this.isActualNetworkError(error)) {
          // Fall through to offline deletion
        } else {
          throw error;
        }
      }
    }

    // Delete note offline (same as before)
    await offlineStorage.deleteCachedNote(noteId);
    
    // Queue for sync when online (if not an offline-only note)
    if (!noteId.startsWith('offline-')) {
      await offlineStorage.storePendingChange({
        type: 'delete',
        noteId: noteId,
        offline: true
      });
    }

    this.dispatchEvent('offline-change', { type: 'delete', noteId });

    return { data: { message: 'Note deleted successfully' } };
  }

  // Get current user with improved error handling
  async getCurrentUser() {
    const token = localStorage.getItem('token');
    if (!token) {
      return null;
    }

    try {
      // Try to get from cache first
      let user = await offlineStorage.getUserData('currentUser');
      
      // If we have cached user data and a token, validate token expiry
      if (user && token) {
        const isTokenValid = this.isTokenValid(token);
        // Reduced auth debug logging frequency
        if (Math.random() < 0.1) { // Only log 10% of the time
          console.log('Auth Debug:', { hasUser: !!user, hasToken: !!token, isTokenValid, isOnline: this.isOnline });
        }
        
        if (isTokenValid) {
          // Token is valid, return cached user
          return user;
        } else {
          console.log('Token expired, will try to refresh if online');
        }
      }
      
      // If online, try to refresh user data from server
      if (this.isOnline) {
        try {
          const response = await this.retryRequest(() => this.api.get('/auth/user'));
          user = response.data;
          
          // Cache the user data and update token timestamp
          await offlineStorage.storeUserData('currentUser', user);
          await offlineStorage.storeMetadata('tokenValidatedAt', Date.now());
          
          return user;
        } catch (error) {
          console.log('Server auth check failed:', error.response?.status, error.message);
          
          if (this.isActualNetworkError(error)) {
            console.log('Network error detected during auth check');
            // Don't immediately go offline just for auth check
          }
          
          // If server request fails but we have cached user and token, use cache even if expired
          if (user && token) {
            console.log('Using cached user despite server error');
            return user;
          }
          
          // Only clear auth data if it's definitely a 401 Unauthorized
          if (error.response?.status === 401) {
            console.log('401 error, clearing auth data');
            await this.clearAuthData();
            return null;
          }
        }
      }
      
      // Offline mode: return cached user if we have both user and token
      if (user && token) {
        console.log('Offline mode: using cached user and token');
        return user;
      }
      
      console.log('No valid cached user found');
      return null;
      
    } catch (error) {
      console.error('Error in getCurrentUser:', error);
      return null;
    }
  }

  // Check if JWT token is still valid (same as before)
  isTokenValid(token) {
    try {
      if (!token || typeof token !== 'string') {
        console.log('Token validation failed: no token or invalid type');
        return false;
      }
      
      const parts = token.split('.');
      if (parts.length !== 3) {
        console.log('Token validation failed: invalid JWT format');
        return false;
      }
      
      const payload = JSON.parse(atob(parts[1]));
      const now = Math.floor(Date.now() / 1000);
      
      if (payload.exp && payload.exp < now) {
        console.log('Token validation failed: token expired', new Date(payload.exp * 1000));
        return false;
      }
      
      console.log('Token validation passed');
      return true;
    } catch (error) {
      console.error('Token validation error:', error);
      return false;
    }
  }

  // Clear all authentication data (same as before)
  async clearAuthData() {
    localStorage.removeItem('token');
    await offlineStorage.storeUserData('currentUser', null);
    await offlineStorage.storeMetadata('tokenValidatedAt', null);
    delete this.api.defaults.headers.common['Authorization'];
  }

  // Sync pending changes when back online with better error handling
  async syncPendingChanges() {
    if (!this.isOnline || this.syncInProgress) {
      return;
    }

    this.syncInProgress = true;
    this.dispatchEvent('sync-start');

    try {
      const pendingChanges = await offlineStorage.getPendingChanges();
      
      for (const change of pendingChanges) {
        try {
          await this.syncSingleChange(change);
          await offlineStorage.removePendingChange(change.id);
        } catch (error) {
          console.error('Failed to sync change:', error);
          
          // If it's a network error, stop syncing
          if (this.isActualNetworkError(error)) {
            console.log('Network error during sync');
            this.consecutiveFailures++;
            // Don't immediately go offline, let normal error handling decide
            break;
          }
          // Continue with other changes for non-network errors
        }
      }

      // Update last sync time only if we're still online
      if (this.isOnline) {
        await offlineStorage.storeMetadata('lastSync', Date.now());
        this.dispatchEvent('sync-complete');
      }
      
    } catch (error) {
      console.error('Sync failed:', error);
      this.dispatchEvent('sync-error', { error });
    } finally {
      this.syncInProgress = false;
    }
  }

  // Sync individual change (same as before)
  async syncSingleChange(change) {
    switch (change.type) {
      case 'create':
        if (change.noteId.startsWith('offline-')) {
          const response = await this.api.post('/api/notes', change.data);
          const newNote = response.data;
          
          const currentUser = await this.getCurrentUser();
          await offlineStorage.deleteCachedNote(change.noteId);
          await offlineStorage.storeNote({
            ...newNote,
            offline: false,
            pendingSync: false
          }, currentUser.id, { fromServer: true });
        }
        break;
        
      case 'update':
        if (!change.noteId.startsWith('offline-')) {
          await this.api.put(`/api/notes/${change.noteId}`, change.data);
          
          const currentUser = await this.getCurrentUser();
          const cachedNote = await offlineStorage.getCachedNote(change.noteId);
          if (cachedNote) {
            await offlineStorage.storeNote({
              ...cachedNote,
              offline: false,
              pendingSync: false
            }, currentUser.id);
          }
        }
        break;
        
      case 'delete':
        await this.api.delete(`/api/notes/${change.noteId}`);
        break;
    }
  }

  // Background sync with connectivity checks
  startBackgroundSync() {
    setInterval(async () => {
      // Only sync if online and not already syncing
      if (this.isOnline && !this.syncInProgress) {
        await this.syncPendingChanges();
      }
    }, 30000); // Check every 30 seconds
  }

  // Get offline status
  getOfflineStatus() {
    return {
      isOnline: this.isOnline,
      syncInProgress: this.syncInProgress,
      failedRequestCount: this.failedRequestCount,
      consecutiveFailures: this.consecutiveFailures
    };
  }

  // Manual sync trigger with connectivity test
  async forcSync() {
    // First test connectivity
    const isOnline = await this.testConnectivity(true); // Force test
    
    if (isOnline) {
      await this.syncPendingChanges();
    }
    
    return isOnline;
  }

  // Manual connectivity test for UI
  async forceConnectivityTest() {
    return await this.testConnectivity(true); // Force test, ignore debounce
  }

  // Cleanup method
  destroy() {
    this.stopConnectivityMonitoring();
    window.removeEventListener('online', this.handleBrowserOnline);
    window.removeEventListener('offline', () => this.setOnlineStatus(false));
  }
}

// Create singleton instance
const api = new OfflineCapableAPI();

export default api;
