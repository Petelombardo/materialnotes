import { useEffect, useRef, useCallback } from 'react';

export const useAppLifecycle = (onResume, onBackground) => {
  const wasBackgroundRef = useRef(false);
  const lastActiveTimeRef = useRef(Date.now());

  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === 'visible') {
      // App became visible
      const now = Date.now();
      const timeSinceLastActive = now - lastActiveTimeRef.current;
      
      console.log('📱 App resumed from background', {
        wasBackground: wasBackgroundRef.current,
        timeSinceLastActive: timeSinceLastActive + 'ms',
        threshold: '10 seconds (UPDATED)' // Clear indicator this is the updated version
      });
      
      // REDUCED: If app was backgrounded for more than 10 seconds (instead of 30), trigger resume logic
      if (wasBackgroundRef.current && timeSinceLastActive > 10000) {
        console.log('🔄 Triggering resume sync (app was backgrounded > 10s)');
        onResume?.();
      }
      
      wasBackgroundRef.current = false;
      lastActiveTimeRef.current = now;
    } else {
      // App became hidden/backgrounded
      console.log('📱 App went to background');
      wasBackgroundRef.current = true;
      onBackground?.();
    }
  }, [onResume, onBackground]);

  const handleFocus = useCallback(() => {
    const now = Date.now();
    const timeSinceLastActive = now - lastActiveTimeRef.current;
    
    console.log('👁️ Window focused', {
      timeSinceLastActive: timeSinceLastActive + 'ms',
      threshold: '10 seconds (UPDATED)'
    });
    
    // REDUCED: Additional check for window focus with 10 second threshold
    if (timeSinceLastActive > 10000) {
      console.log('🔄 Triggering resume sync (window was unfocused > 10s)');
      onResume?.();
    }
    
    lastActiveTimeRef.current = now;
  }, [onResume]);

  const handleBlur = useCallback(() => {
    console.log('👁️ Window blurred');
    onBackground?.();
  }, [onBackground]);

  // NEW: Add immediate sync on tab/window focus for faster collaboration
  const handlePageShow = useCallback((e) => {
    if (e.persisted) {
      // Page was restored from cache (back/forward navigation)
      console.log('📱 Page restored from cache - triggering immediate sync');
      onResume?.();
    }
  }, [onResume]);

  const handlePageHide = useCallback(() => {
    console.log('📱 Page hidden');
    onBackground?.();
  }, [onBackground]);

  useEffect(() => {
    // Listen for visibility changes (mobile screen on/off)
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Listen for window focus/blur (desktop/mobile browser tab changes)
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    
    // Mobile-specific events with enhanced handling
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('pagehide', handlePageHide);
    
    // NEW: Additional mobile-specific events for better sync timing
    window.addEventListener('beforeunload', handlePageHide);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
    };
  }, [handleVisibilityChange, handleFocus, handleBlur, handlePageShow, handlePageHide]);

  return {
    isVisible: document.visibilityState === 'visible',
    timeSinceLastActive: Date.now() - lastActiveTimeRef.current
  };
};