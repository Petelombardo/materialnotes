import React, { useState, useEffect } from 'react';
import {
  Snackbar,
  Alert,
  Button,
  useTheme,
  useMediaQuery
} from '@mui/material';
import api from '../utils/api';

const OfflineStatus = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showOfflineAlert, setShowOfflineAlert] = useState(false);
  const [syncInProgress, setSyncInProgress] = useState(false);
  
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  useEffect(() => {
    // Listen to API offline/online events
    const handleOnline = () => {
      setIsOnline(true);
      setShowOfflineAlert(false);
    };
    
    const handleOffline = () => {
      setIsOnline(false);
      setShowOfflineAlert(true);
    };
    
    const handleSyncStart = () => setSyncInProgress(true);
    const handleSyncComplete = () => {
      setSyncInProgress(false);
      setShowOfflineAlert(false);
    };
    
    api.addEventListener('online', handleOnline);
    api.addEventListener('offline', handleOffline);
    api.addEventListener('sync-start', handleSyncStart);
    api.addEventListener('sync-complete', handleSyncComplete);
    
    // Set initial state
    const status = api.getOfflineStatus();
    setIsOnline(status.isOnline);
    setSyncInProgress(status.syncInProgress);
    
    if (!status.isOnline) {
      setShowOfflineAlert(true);
    }

    return () => {
      api.removeEventListener('online', handleOnline);
      api.removeEventListener('offline', handleOffline);
      api.removeEventListener('sync-start', handleSyncStart);
      api.removeEventListener('sync-complete', handleSyncComplete);
    };
  }, []);

  const handleRetryConnection = async () => {
    try {
      const isConnected = await api.forceConnectivityTest();
      if (isConnected) {
        setShowOfflineAlert(false);
      }
    } catch (error) {
      console.error('Retry connection failed:', error);
    }
  };

  const handleDismiss = () => {
    setShowOfflineAlert(false);
  };

  return null;
};

export default OfflineStatus;