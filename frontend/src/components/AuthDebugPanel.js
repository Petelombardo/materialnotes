import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Paper,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Alert
} from '@mui/material';
import { ExpandMore, BugReport, Delete } from '@mui/icons-material';
import offlineStorage from '../utils/offlineStorage';
import api from '../utils/api';

// Add this component temporarily to your App.js for debugging
// Remove it once authentication is working properly
const AuthDebugPanel = () => {
  const [debugInfo, setDebugInfo] = useState({});
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    loadDebugInfo();
  }, []);

  const loadDebugInfo = async () => {
    try {
      const token = localStorage.getItem('token');
      const cachedUser = await offlineStorage.getUserData('currentUser');
      const tokenValidatedAt = await offlineStorage.getMetadata('tokenValidatedAt');
      const cacheStats = await offlineStorage.getCacheStats();
      const isOnline = navigator.onLine;

      let tokenInfo = null;
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          tokenInfo = {
            valid: api.isTokenValid(token),
            expiresAt: new Date(payload.exp * 1000).toLocaleString(),
            issuedAt: new Date(payload.iat * 1000).toLocaleString(),
            userId: payload.id
          };
        } catch (e) {
          tokenInfo = { error: 'Invalid token format' };
        }
      }

      setDebugInfo({
        hasToken: !!token,
        tokenInfo,
        hasCachedUser: !!cachedUser,
        cachedUser: cachedUser ? { id: cachedUser.id, name: cachedUser.name, email: cachedUser.email } : null,
        tokenValidatedAt: tokenValidatedAt ? new Date(tokenValidatedAt).toLocaleString() : 'Never',
        cacheStats,
        isOnline,
        apiOnlineStatus: api.getOfflineStatus()
      });
    } catch (error) {
      console.error('Failed to load debug info:', error);
    }
  };

  const clearAllAuth = async () => {
    await api.clearAuthData();
    await offlineStorage.clearAllCache();
    window.location.reload();
  };

  const forceTokenValidation = async () => {
    try {
      const user = await api.getCurrentUser();
      console.log('Token validation result:', user);
      loadDebugInfo();
    } catch (error) {
      console.error('Token validation failed:', error);
    }
  };

  if (!showDebug) {
    return (
      <Button
        onClick={() => setShowDebug(true)}
        startIcon={<BugReport />}
        sx={{ position: 'fixed', bottom: 80, left: 16, zIndex: 1000 }}
        variant="outlined"
        size="small"
      >
        Debug Auth
      </Button>
    );
  }

  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        width: 400,
        maxHeight: '80vh',
        overflow: 'auto',
        zIndex: 1000
      }}
    >
      <Paper elevation={8} sx={{ p: 2 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
          <Typography variant="h6">Auth Debug Panel</Typography>
          <Button onClick={() => setShowDebug(false)} size="small">Close</Button>
        </Box>

        <Accordion>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography>Authentication Status</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box display="flex" flexDirection="column" gap={1}>
              <Chip 
                label={`Token: ${debugInfo.hasToken ? 'Present' : 'Missing'}`}
                color={debugInfo.hasToken ? 'success' : 'error'}
                size="small"
              />
              <Chip 
                label={`Cached User: ${debugInfo.hasCachedUser ? 'Present' : 'Missing'}`}
                color={debugInfo.hasCachedUser ? 'success' : 'error'}
                size="small"
              />
              <Chip 
                label={`Online: ${debugInfo.isOnline ? 'Yes' : 'No'}`}
                color={debugInfo.isOnline ? 'success' : 'warning'}
                size="small"
              />
            </Box>
          </AccordionDetails>
        </Accordion>

        {debugInfo.tokenInfo && (
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography>Token Details</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography variant="body2" component="pre" sx={{ fontSize: '0.75rem' }}>
                {JSON.stringify(debugInfo.tokenInfo, null, 2)}
              </Typography>
            </AccordionDetails>
          </Accordion>
        )}

        {debugInfo.cachedUser && (
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography>Cached User</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Typography variant="body2" component="pre" sx={{ fontSize: '0.75rem' }}>
                {JSON.stringify(debugInfo.cachedUser, null, 2)}
              </Typography>
            </AccordionDetails>
          </Accordion>
        )}

        <Accordion>
          <AccordionSummary expandIcon={<ExpandMore />}>
            <Typography>Cache Stats</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" component="pre" sx={{ fontSize: '0.75rem' }}>
              {JSON.stringify(debugInfo.cacheStats, null, 2)}
            </Typography>
          </AccordionDetails>
        </Accordion>

        <Box mt={2} display="flex" flexDirection="column" gap={1}>
          <Button onClick={loadDebugInfo} size="small" variant="outlined">
            Refresh Debug Info
          </Button>
          <Button onClick={forceTokenValidation} size="small" variant="outlined">
            Test Token Validation
          </Button>
          <Button 
            onClick={clearAllAuth} 
            size="small" 
            variant="contained" 
            color="error"
            startIcon={<Delete />}
          >
            Clear All Auth Data
          </Button>
        </Box>

        <Alert severity="info" sx={{ mt: 2 }}>
          <Typography variant="caption">
            This debug panel helps troubleshoot authentication issues. 
            Remove it from your App.js once everything is working.
          </Typography>
        </Alert>
      </Paper>
    </Box>
  );
};

export default AuthDebugPanel;