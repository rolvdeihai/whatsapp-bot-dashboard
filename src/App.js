// whatsapp-bot-dashboard/src/App.js

import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000';

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

  // 🚀 SIMPLIFIED: Load only saved groups
  const loadSavedGroups = async () => {
    if (selectedGroups.length === 0) {
      setSavedGroups([]);
      return;
    }

    try {
      const response = await fetch(`${backendUrl}/api/groups/saved`, {
        method: 'POST',
        headers: {
          'ngrok-skip-browser-warning': '1',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ groupIds: selectedGroups }),
      });

      if (response.ok) {
        const groups = await response.json();
        setSavedGroups(groups);
      }
    } catch (error) {
      console.error('Error loading saved groups:', error);
    }
  };

  // 🚀 SIMPLIFIED: Search groups
  const searchGroups = async () => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const response = await fetch(`${backendUrl}/api/groups/search?q=${encodeURIComponent(searchQuery)}`);
      if (response.ok) {
        const results = await response.json();
        setSearchResults(results);
      }
    } catch (error) {
      console.error('Error searching groups:', error);
    } finally {
      setSearching(false);
    }
  };

  // 🚀 SIMPLIFIED: Socket connection
  useEffect(() => {
    const newSocket = io(backendUrl, {
      transports: ['websocket', 'polling'],
      timeout: 10000
    });

    setSocket(newSocket);

    newSocket.on('qr-code', (data) => {
      setQrCode(data.qr);
      setIsLoading(false);
    });

    newSocket.on('bot-status', (data) => {
      setBotStatus(data.status);
      setIsLoading(false);
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

  // 🚀 SIMPLIFIED: Load saved groups when selection changes
  useEffect(() => {
    if (botStatus === 'connected' || botStatus === 'session_exists') {
      loadSavedGroups();
    }
  }, [selectedGroups, botStatus]);

  // 🚀 SIMPLIFIED: Initial session check
  useEffect(() => {
    const checkSessionStatus = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/bot-status`);
        const data = await response.json();
        setBotStatus(data.status);
      } catch (error) {
        console.log('Error checking session status:', error);
      }
    };

    checkSessionStatus();
  }, []);

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
  };

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
        headers: {
          'ngrok-skip-browser-warning': '1',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ groups: selectedGroups }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      
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

  return (
    <div className="App">
      <header className="App-header">
        <h1>WhatsApp Bot Dashboard</h1>
        <div className={`status ${botStatus}`}>
          Status: {botStatus === 'session_exists' ? 'Session Found (Auto-connecting...)' : botStatus}
        </div>
      </header>

      <div className="dashboard">
        <section className="connection-section">
          <h2>Bot Connection</h2>
          <div className="button-group">
            <button 
              onClick={startBot} 
              disabled={['connected', 'scan_qr', 'session_exists'].includes(botStatus) || isLoading}
              className="btn btn-primary"
            >
              {isLoading ? 'Loading...' : 
               botStatus === 'connected' ? 'Connected' : 
               botStatus === 'scan_qr' ? 'Scan QR Code' : 
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
            </div>
          )}
        </section>

        {(botStatus === 'connected' || botStatus === 'session_exists') && (
          <section className="groups-section">
            <h2>Manage Active Groups</h2>
            
            {/* 🚀 SIMPLIFIED: Search to add groups */}
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

            {/* 🚀 SIMPLIFIED: Show only saved groups */}
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

            {botStatus === 'session_exists' && (
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