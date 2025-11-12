// whatsapp-bot-dashboard/src/App.js

import React, { useState, useEffect, useCallback } from 'react';
import io from 'socket.io-client';
import './App.css';

const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000';

// 🧠 Common headers to bypass ngrok warning
const commonHeaders = {
  'ngrok-skip-browser-warning': '1',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': backendUrl,
  'Content-Type': 'application/json'
};

function App() {
  const [socket, setSocket] = useState(null);
  const [qrCode, setQrCode] = useState('');
  const [botStatus, setBotStatus] = useState('disconnected');
  const [savedGroups, setSavedGroups] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroups, setSelectedGroups] = useState(() => {
    const saved = localStorage.getItem('activeGroups');
    return saved ? JSON.parse(saved) : [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sessionRetryInfo, setSessionRetryInfo] = useState(null);
  const [canUseSession, setCanUseSession] = useState(false);

  // 🆕 NEW: Force QR generation
  const forceQR = () => {
    if (!socket) return;
    console.log('Requesting force QR generation...');
    socket.emit('force-qr');
    setIsLoading(true);
  };

  // 🆕 NEW: Retry session restoration
  const retrySession = () => {
    if (!socket) return;
    console.log('Requesting session retry...');
    
    // Use different events based on current status
    if (botStatus === 'session_exists' || botStatus === 'authenticating_with_session') {
      socket.emit('force-retry');
    } else {
      socket.emit('retry-session');
    }
    
    setIsLoading(true);
  };

  // 🧠 Helper: safely parse JSON or detect ngrok splash
  const parseJsonSafely = async (response) => {
    const text = await response.text();
    if (text.startsWith('<!DOCTYPE html') || text.includes('ERR_NGROK_6024')) {
      throw new Error('Blocked by ngrok splash page (ERR_NGROK_6024)');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Invalid JSON response');
    }
  };

  // 🚀 Load saved groups
  const loadSavedGroups = useCallback(async () => {
    if (selectedGroups.length === 0) {
      setSavedGroups([]);
      return;
    }
    try {
      const response = await fetch(`${backendUrl}/api/groups/saved`, {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({ groupIds: selectedGroups }),
      });
      if (response.ok) {
        const groups = await parseJsonSafely(response);
        setSavedGroups(groups);
      } else {
        console.error('Failed to load saved groups:', response.status);
      }
    } catch (error) {
      console.error('Error loading saved groups:', error);
    }
  }, [selectedGroups]); // Add dependencies that this function uses

  // 🚀 Load saved groups when selection changes
  useEffect(() => {
    if (botStatus === 'connected' || botStatus === 'session_exists') {
      loadSavedGroups();
    }
  }, [selectedGroups, botStatus, loadSavedGroups]); // Now include loadSavedGroups in dependencies

  // 🚀 Search groups
  const searchGroups = async () => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const response = await fetch(`${backendUrl}/api/groups/search?q=${encodeURIComponent(searchQuery)}`, {
        headers: commonHeaders,
      });
      if (response.ok) {
        const results = await parseJsonSafely(response);
        setSearchResults(results);
      } else {
        console.error('Failed to search groups:', response.status);
      }
    } catch (error) {
      console.error('Error searching groups:', error);
      alert('❌ Search failed: ' + error.message);
    } finally {
      setSearching(false);
    }
  };

  // 🚀 Socket connection
  useEffect(() => {
    const newSocket = io(backendUrl, {
      transports: ['websocket', 'polling'],
      timeout: 10000
    });

    setSocket(newSocket);

    newSocket.on('qr-code', (data) => {
      setQrCode(data.qr);
      setCanUseSession(data.canUseSession || false);
      setIsLoading(false);
    });

    newSocket.on('bot-status', (data) => {
      setBotStatus(data.status);
      setIsLoading(false);
      
      // Handle session retry information
      if (data.status === 'session_retry' || data.status === 'session_retry_after_qr') {
        setSessionRetryInfo({
          attempt: data.attempt,
          maxAttempts: data.maxAttempts,
          error: data.error
        });
      } else {
        setSessionRetryInfo(null);
      }
      
      // Clear QR code if not in QR mode
      if (data.status !== 'scan_qr' && data.status !== 'session_retry_after_qr') {
        setQrCode('');
        setCanUseSession(false);
      }
      
      if (data.qrCode) setQrCode(data.qrCode);
    });

    newSocket.on('active-groups-updated', (data) => {
      setSelectedGroups(data.groups);
      localStorage.setItem('activeGroups', JSON.stringify(data.groups));
    });

    newSocket.on('bot-error', (data) => {
      alert('Bot error: ' + data.error);
      setIsLoading(false);
    });

    return () => newSocket.close();
  }, []);

  // 🚀 Initial session check
  useEffect(() => {
    const checkSessionStatus = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/bot-status`, {
          headers: commonHeaders,
        });
        const data = await parseJsonSafely(response);
        setBotStatus(data.status);
      } catch (error) {
        console.log('Error checking session status:', error);
      }
    };
    checkSessionStatus();
  }, []);

  // 🚀 Bot controls
  const startBot = () => {
    if (isLoading || !socket) return;
    setIsLoading(true);
    socket.emit('start-bot');
  };

  const stopBot = () => {
    if (!socket) return;
    socket.emit('stop-bot');
    setIsLoading(false);
    setQrCode('');
    setCanUseSession(false);
  };

  const getStatusDisplay = () => {
    switch (botStatus) {
      case 'waiting_for_session':
        return '🔄 Restoring Session from Backup...';
      case 'authenticating_with_session':
        return '🔐 Authenticating with Saved Session...';
      case 'session_retry':
        return `🔄 Attempting Session Restoration (${sessionRetryInfo?.attempt || 1}/${sessionRetryInfo?.maxAttempts || 3})...`;
      case 'session_retry_after_qr':
        return `🔄 Session Found! Retrying Authentication (${sessionRetryInfo?.attempt || 1}/${sessionRetryInfo?.maxAttempts || 3})...`;
      case 'session_restore_failed':
        return '❌ Session Restoration Failed';
      case 'session_exists':
        return '📱 Session Found (Auto-connecting...)';
      case 'scan_qr':
        return canUseSession ? '📱 QR Code (Session Available - Try "Use Session" Below)' : '📱 Scan QR Code';
      case 'connected':
        return '✅ Connected';
      case 'authenticated':
        return '🔐 Authenticated';
      default:
        return '❌ Disconnected';
    }
  };

  // 🚀 Manage group selections
  const toggleGroup = (groupId) => {
    const newSelectedGroups = selectedGroups.includes(groupId)
      ? selectedGroups.filter(id => id !== groupId)
      : [...selectedGroups, groupId];
    
    setSelectedGroups(newSelectedGroups);
    localStorage.setItem('activeGroups', JSON.stringify(newSelectedGroups));
  };

  const saveActiveGroups = async () => {
    try {
      const response = await fetch(`${backendUrl}/api/active-groups`, {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify({ groups: selectedGroups }),
      });

      const result = await parseJsonSafely(response);
      if (result.success) {
        alert('✅ Active groups saved!');
      } else {
        throw new Error(result.error || 'Failed to save groups');
      }
    } catch (error) {
      console.error('Error saving groups:', error);
      alert(`❌ Failed to save groups: ${error.message}`);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    searchGroups();
  };

  // 🚀 UI Rendering
  return (
    <div className="App">
      <header className="App-header">
        <h1>WhatsApp Bot Dashboard</h1>
        <div className={`status ${botStatus}`}>
          Status: {getStatusDisplay()}
        </div>
        
        {/* 🆕 NEW: Session retry info */}
        {sessionRetryInfo?.error && (
          <div className="error-message">
            Error: {sessionRetryInfo.error}
          </div>
        )}
      </header>

      <div className="dashboard">
        <section className="connection-section">
          <h2>Bot Connection</h2>

          {/* 🆕 ADD: Retry options for stuck auto-connection */}
          {(botStatus === 'session_exists' || botStatus === 'authenticating_with_session') && (
            <div className="session-controls">
              <p>Auto-connection is taking longer than expected.</p>
              <div className="button-group">
                <button onClick={retrySession} className="btn btn-warning" disabled={isLoading}>
                  {isLoading ? 'Retrying...' : 'Force Retry Connection'}
                </button>
                <button onClick={forceQR} className="btn btn-secondary">
                  Use QR Code Instead
                </button>
              </div>
            </div>
          )}
          
          {/* 🆕 ADD: Retry options for other stuck states */}
          {(botStatus === 'waiting_for_session' || botStatus === 'session_retry') && (
            <div className="session-controls">
              <p>Session restoration is taking longer than expected.</p>
              <div className="button-group">
                <button onClick={retrySession} className="btn btn-warning" disabled={isLoading}>
                  {isLoading ? 'Retrying...' : 'Retry Session'}
                </button>
                <button onClick={forceQR} className="btn btn-secondary">
                  Use QR Code Instead
                </button>
              </div>
            </div>
          )}

          <div className="button-group">
            <button 
              onClick={startBot} 
              disabled={[
                'connected', 'scan_qr', 'session_exists', 
                'waiting_for_session', 'authenticating_with_session',
                'session_retry', 'session_retry_after_qr'
              ].includes(botStatus) || isLoading}
              className="btn btn-primary"
            >
              {isLoading ? 'Loading...' : 
              botStatus === 'connected' ? 'Connected' : 
              botStatus === 'scan_qr' ? 'Scan QR Code' : 
              botStatus === 'waiting_for_session' ? 'Restoring Session...' :
              botStatus === 'authenticating_with_session' ? 'Authenticating...' :
              botStatus === 'session_retry' ? 'Retrying Session...' :
              botStatus === 'session_retry_after_qr' ? 'Retrying Authentication...' :
              botStatus === 'session_exists' ? 'Auto-Connecting...' : 'Start Bot'}
            </button>
            
            {botStatus === 'connected' && (
              <button onClick={stopBot} className="btn btn-danger">
                Stop Bot
              </button>
            )}
          </div>
          
          {qrCode && botStatus === 'scan_qr' && (
            <div className="qr-code">
              <p>Scan this QR code with WhatsApp to connect:</p>
              <img src={qrCode} alt="QR Code" />
              
              {/* 🆕 NEW: QR alternative options */}
              <div className="qr-options">
                {canUseSession ? (
                  <p className="session-option">
                    💡 <strong>Session available!</strong> Try{' '}
                    <button onClick={retrySession} className="btn-link">
                      using your saved session
                    </button>{' '}
                    if QR scan fails.
                  </p>
                ) : (
                  <p className="no-session">
                    ℹ️ No saved session found. You must scan the QR code.
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        {(botStatus === 'connected' || botStatus === 'session_exists' || 
          botStatus === 'authenticating_with_session' || botStatus === 'waiting_for_session') && (
          <section className="groups-section">
            <h2>Manage Active Groups</h2>
            
            {/* 🚀 Search section */}
            <div className="search-section">
              <h3>Add New Groups</h3>
              <form onSubmit={handleSearch} className="search-form">
                <input
                  type="text"
                  placeholder="Search for groups by name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                />
                <button type="submit" disabled={searching || !searchQuery} className="btn btn-secondary">
                  {searching ? 'Searching...' : 'Search'}
                </button>
              </form>

              {searchResults.length > 0 && (
                <div className="search-results">
                  <h4>Search Results ({searchResults.length})</h4>
                  {searchResults.map(group => (
                    <div key={group.id} className="group-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedGroups.includes(group.id)}
                          onChange={() => toggleGroup(group.id)}
                          disabled={botStatus === 'session_exists'}
                        />
                        <span className="group-name">{group.name}</span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 🚀 Saved groups */}
            <div className="saved-groups">
              <h3>Active Groups ({selectedGroups.length})</h3>
              
              {selectedGroups.length === 0 ? (
                <p className="no-groups">No active groups. Use search above to add groups.</p>
              ) : (
                <div className="groups-list">
                  {savedGroups.map(group => (
                    <div key={group.id} className="group-item saved">
                      <label>
                        <input
                          type="checkbox"
                          checked={true}
                          onChange={() => toggleGroup(group.id)}
                          disabled={botStatus === 'session_exists'}
                        />
                        <span className="group-name">{group.name}</span>
                        <button 
                          onClick={() => toggleGroup(group.id)}
                          className="btn-remove"
                          title="Remove group"
                        >
                          ×
                        </button>
                      </label>
                    </div>
                  ))}
                </div>
              )}

              {selectedGroups.length > 0 && (
                <button 
                  onClick={saveActiveGroups} 
                  disabled={botStatus === 'session_exists'}
                  className="btn btn-success save-btn"
                >
                  Save Active Groups
                </button>
              )}
            </div>

            {(botStatus === 'waiting_for_session' || botStatus === 'authenticating_with_session') && (
              <div className="info-message">
                <p>📱 <strong>Auto-connecting...</strong> You can search for groups but cannot modify selections until connected.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default App;
