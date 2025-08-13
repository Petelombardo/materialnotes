const fs = require('fs-extra');
const path = require('path');

class FileLockManager {
  constructor() {
    this.locks = new Map(); // In-memory locks for quick access
    this.lockDir = path.join(__dirname, '../data/locks');
    this.ensureLockDir();
  }

  async ensureLockDir() {
    await fs.ensureDir(this.lockDir);
  }

  // Generate lock file path
  getLockFilePath(noteId) {
    return path.join(this.lockDir, `${noteId}.lock`);
  }

  // Acquire lock for editing a note
  async acquireLock(noteId, userId, timeoutMs = 30000) {
    const lockFilePath = this.getLockFilePath(noteId);
    const lockInfo = {
      userId,
      timestamp: Date.now(),
      timeout: timeoutMs
    };

    try {
      // Check if lock file exists and is still valid
      if (await fs.pathExists(lockFilePath)) {
        const existingLock = await fs.readJson(lockFilePath);
        const isExpired = Date.now() - existingLock.timestamp > existingLock.timeout;
        
        if (!isExpired && existingLock.userId !== userId) {
          return {
            success: false,
            error: 'Note is being edited by another user',
            lockedBy: existingLock.userId,
            lockedAt: new Date(existingLock.timestamp)
          };
        }
        
        // If expired or same user, remove old lock
        if (isExpired || existingLock.userId === userId) {
          await fs.remove(lockFilePath);
          this.locks.delete(noteId);
        }
      }

      // Create new lock
      await fs.writeJson(lockFilePath, lockInfo);
      this.locks.set(noteId, lockInfo);

      // Set auto-cleanup timer
      setTimeout(() => {
        this.releaseLock(noteId, userId).catch(console.error);
      }, timeoutMs);

      return { success: true, lockInfo };

    } catch (error) {
      console.error('Error acquiring lock:', error);
      return {
        success: false,
        error: 'Failed to acquire lock'
      };
    }
  }

  // Release lock
  async releaseLock(noteId, userId) {
    const lockFilePath = this.getLockFilePath(noteId);

    try {
      if (await fs.pathExists(lockFilePath)) {
        const existingLock = await fs.readJson(lockFilePath);
        
        // Only release if same user or lock is expired
        const isExpired = Date.now() - existingLock.timestamp > existingLock.timeout;
        if (existingLock.userId === userId || isExpired) {
          await fs.remove(lockFilePath);
          this.locks.delete(noteId);
          return { success: true };
        } else {
          return {
            success: false,
            error: 'Cannot release lock owned by another user'
          };
        }
      }

      // Remove from memory if exists
      this.locks.delete(noteId);
      return { success: true };

    } catch (error) {
      console.error('Error releasing lock:', error);
      return {
        success: false,
        error: 'Failed to release lock'
      };
    }
  }

  // Extend lock (refresh timeout)
  async extendLock(noteId, userId, additionalTimeMs = 30000) {
    const lockFilePath = this.getLockFilePath(noteId);

    try {
      if (await fs.pathExists(lockFilePath)) {
        const existingLock = await fs.readJson(lockFilePath);
        
        if (existingLock.userId === userId) {
          const updatedLock = {
            ...existingLock,
            timestamp: Date.now(),
            timeout: additionalTimeMs
          };
          
          await fs.writeJson(lockFilePath, updatedLock);
          this.locks.set(noteId, updatedLock);
          
          return { success: true, lockInfo: updatedLock };
        } else {
          return {
            success: false,
            error: 'Cannot extend lock owned by another user'
          };
        }
      }

      return {
        success: false,
        error: 'Lock not found'
      };

    } catch (error) {
      console.error('Error extending lock:', error);
      return {
        success: false,
        error: 'Failed to extend lock'
      };
    }
  }

  // Check lock status
  async checkLock(noteId) {
    const lockFilePath = this.getLockFilePath(noteId);

    try {
      if (await fs.pathExists(lockFilePath)) {
        const lockInfo = await fs.readJson(lockFilePath);
        const isExpired = Date.now() - lockInfo.timestamp > lockInfo.timeout;
        
        if (isExpired) {
          // Clean up expired lock
          await fs.remove(lockFilePath);
          this.locks.delete(noteId);
          return { locked: false };
        }

        return {
          locked: true,
          userId: lockInfo.userId,
          timestamp: lockInfo.timestamp,
          expiresAt: lockInfo.timestamp + lockInfo.timeout
        };
      }

      return { locked: false };

    } catch (error) {
      console.error('Error checking lock:', error);
      return { locked: false, error: 'Failed to check lock status' };
    }
  }

  // Force release lock (admin function)
  async forceReleaseLock(noteId) {
    const lockFilePath = this.getLockFilePath(noteId);

    try {
      if (await fs.pathExists(lockFilePath)) {
        await fs.remove(lockFilePath);
      }
      this.locks.delete(noteId);
      return { success: true };

    } catch (error) {
      console.error('Error force releasing lock:', error);
      return {
        success: false,
        error: 'Failed to force release lock'
      };
    }
  }

  // Cleanup expired locks (maintenance function)
  async cleanupExpiredLocks() {
    try {
      const lockFiles = await fs.readdir(this.lockDir);
      let cleanedCount = 0;

      for (const lockFile of lockFiles) {
        if (!lockFile.endsWith('.lock')) continue;

        const lockFilePath = path.join(this.lockDir, lockFile);
        const lockInfo = await fs.readJson(lockFilePath);
        const isExpired = Date.now() - lockInfo.timestamp > lockInfo.timeout;

        if (isExpired) {
          await fs.remove(lockFilePath);
          const noteId = path.basename(lockFile, '.lock');
          this.locks.delete(noteId);
          cleanedCount++;
        }
      }

      return { cleaned: cleanedCount };

    } catch (error) {
      console.error('Error cleaning up expired locks:', error);
      return { error: 'Failed to cleanup expired locks' };
    }
  }
}

// Singleton instance
const fileLockManager = new FileLockManager();

// Cleanup expired locks every 5 minutes
setInterval(() => {
  fileLockManager.cleanupExpiredLocks().catch(console.error);
}, 5 * 60 * 1000);

module.exports = fileLockManager;