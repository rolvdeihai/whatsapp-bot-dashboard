import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000';

function App() {
  const [socket, setSocket] = useState(null);
  const [qrCode, setQrCode] = useState('');
  const [botStatus, setBotStatus] = useState('disconnected');
  const [groups, setGroups] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState(() => {
    const savedGroups = localStorage.getItem('activeGroups');
    return savedGroups ? JSON.parse(savedGroups) : [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [visibleGroups, setVisibleGroups] = useState(20);

  // Refs for stable values
  const selectedGroupsRef = useRef(selectedGroups);
  const groupsLoadedRef = useRef(false);
  const loadAttemptRef = useRef(0);

  // Update ref when selectedGroups changes
  useEffect(() => {
    selectedGroupsRef.current = selectedGroups;
  }, [selectedGroups]);

  // 🚀 STABLE: Fetch groups with retry logic
  const fetchGroups = async (usePreview = true) => {
    if (groupsLoading) return;
    
    setGroupsLoading(true);
    loadAttemptRef.current += 1;
    const currentAttempt = loadAttemptRef.current;

    try {
      console.log(`🔄 Attempt ${currentAttempt}: Loading groups...`);
      
      let endpoint = usePreview ? '/api/groups/preview' : '/api/groups';
      const response = await fetch(`${backendUrl}${endpoint}`);
      
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const groupsData = await response.json();
      console.log(`✅ Loaded ${groupsData.length} groups`);

      // Only update if this is the most recent request
      if (currentAttempt === loadAttemptRef.current) {
        setGroups(groupsData);
        groupsLoadedRef.current = true;

        // Load details for selected groups
        if (groupsData.length > 0 && selectedGroupsRef.current.length > 0) {
          loadSelectedGroupsDetails(selectedGroupsRef.current);
        }
      }
    } catch (error) {
      console.error('Error fetching groups:', error);
      
      // Retry with full endpoint if preview fails
      if (usePreview && currentAttempt === loadAttemptRef.current) {
        console.log('🔄 Preview failed, trying full endpoint...');
        await fetchGroups(false);
      }
    } finally {
      if (currentAttempt === loadAttemptRef.current) {
        setGroupsLoading(false);
      }
    }
  };

  const loadSelectedGroupsDetails = async (groupIds) => {
    if (groupIds.length === 0) return;
    
    try {
      console.log(`🔍 Loading details for ${groupIds.length} selected groups...`);
      const response = await fetch(`${backendUrl}/api/groups/details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds }),
      });

      if (response.ok) {
        const detailedGroups = await response.json();
        
        setGroups(prevGroups => 
          prevGroups.map(group => {
            const detailed = detailedGroups.find(g => g.id === group.id);
            return detailed ? { ...group, ...detailed } : group;
          })
        );
      }
    } catch (error) {
      console.error('Error loading group details:', error);
    }
  };

  // 🚀 STABLE: Socket connection - runs only once
  useEffect(() => {
    console.log('🔌 Initializing socket connection...');
    const newSocket = io(backendUrl, {
      transports: ['websocket', 'polling'],
      timeout: 10000,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    setSocket(newSocket);

    const handleQrCode = (data) => {
      console.log('📱 QR code received');
      setQrCode(data.qr);
      setIsLoading(false);
    };

    const handleBotStatus = (data) => {
      console.log('🤖 Bot status:', data.status);
      setBotStatus(data.status);
      setIsLoading(false);
      
      if (data.qrCode) {
        setQrCode(data.qrCode);
      }
    };

    const handleActiveGroups = (data) => {
      console.log('📋 Active groups updated:', data.groups.length);
      setSelectedGroups(data.groups);
      localStorage.setItem('activeGroups', JSON.stringify(data.groups));
    };

    const handleBotError = (data) => {
      console.error('❌ Bot error:', data.error);
      alert('Bot error: ' + data.error);
      setIsLoading(false);
    };

    newSocket.on('qr-code', handleQrCode);
    newSocket.on('bot-status', handleBotStatus);
    newSocket.on('active-groups-updated', handleActiveGroups);
    newSocket.on('bot-error', handleBotError);
    newSocket.on('connect', () => console.log('✅ Socket connected'));
    newSocket.on('disconnect', () => console.log('🔌 Socket disconnected'));

    return () => {
      console.log('🧹 Cleaning up socket...');
      newSocket.off('qr-code', handleQrCode);
      newSocket.off('bot-status', handleBotStatus);
      newSocket.off('active-groups-updated', handleActiveGroups);
      newSocket.off('bot-error', handleBotError);
      newSocket.close();
    };
  }, []);

  // 🚀 STABLE: Load groups when bot becomes ready
  useEffect(() => {
    if ((botStatus === 'connected' || botStatus === 'session_exists') && !groupsLoadedRef.current) {
      console.log(`🚀 Bot is ${botStatus}, loading groups...`);
      fetchGroups(true);
    }
  }, [botStatus]);

  // 🚀 STABLE: Initial session check
  useEffect(() => {
    const checkSessionStatus = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/bot-status`);
        const data = await response.json();
        console.log('🔍 Initial session status:', data.status);
        setBotStatus(data.status);
      } catch (error) {
        console.log('Error checking session status:', error);
      }
    };

    checkSessionStatus();
  }, []);

  // Reset when bot disconnects
  useEffect(() => {
    if (botStatus === 'disconnected') {
      groupsLoadedRef.current = false;
      loadAttemptRef.current = 0;
    }
  }, [botStatus]);

  const startBot = () => {
    if (isLoading || !socket) return;
    console.log('🎯 Manually starting bot');
    setIsLoading(true);
    socket.emit('start-bot');
  };

  const stopBot = () => {
    if (!socket) return;
    console.log('🛑 Manually stopping bot');
    socket.emit('stop-bot');
    setIsLoading(false);
    setQrCode('');
    groupsLoadedRef.current = false;
    loadAttemptRef.current = 0;
    setGroups([]);
  };

  const toggleGroup = (groupId) => {
    const newSelectedGroups = selectedGroups.includes(groupId)
      ? selectedGroups.filter(id => id !== groupId)
      : [...selectedGroups, groupId];
    
    setSelectedGroups(newSelectedGroups);
    localStorage.setItem('activeGroups', JSON.stringify(newSelectedGroups));

    // Load details for newly selected group
    if (!selectedGroups.includes(groupId)) {
      loadSelectedGroupsDetails([groupId]);
    }
  };

  const saveActiveGroups = async () => {
    try {
      await fetch(`${backendUrl}/api/active-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: selectedGroups }),
      });
      alert('✅ Active groups updated successfully!');
    } catch (error) {
      console.error('Error saving groups:', error);
      alert('❌ Failed to save groups');
    }
  };

  const reloadGroups = () => {
    groupsLoadedRef.current = false;
    loadAttemptRef.current = 0;
    fetchGroups(true);
  };

  const loadMoreGroups = () => {
    setVisibleGroups(prev => prev + 20);
  };

  // Reset visible groups when groups change
  useEffect(() => {
    setVisibleGroups(20);
  }, [groups]);

  return (
    <div className="App">
      <header className="App-header">
        <h1>WhatsApp Bot Dashboard</h1>
        <div className={`status ${botStatus}`}>
          Status: {botStatus === 'session_exists' ? 'Session Found (Auto-connecting...)' : botStatus}
          {groupsLoading && ' • Loading groups...'}
        </div>
      </header>

      <div className="dashboard">
        <section className="connection-section">
          <h2>Bot Connection</h2>
          <p><em>Bot runs automatically. Use controls below for manual management.</em></p>
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
            <div className="groups-header">
              <h2>Select Active Groups</h2>
              <div className="groups-controls">
                <button 
                  onClick={reloadGroups}
                  disabled={groupsLoading}
                  className="btn btn-secondary"
                >
                  {groupsLoading ? 'Loading...' : `Reload Groups (${groups.length})`}
                </button>
              </div>
            </div>
            
            <p>Choose which groups the bot should respond in:</p>
            
            <div className="groups-list">
              {groupsLoading && groups.length === 0 ? (
                <div className="loading-groups">
                  <p>Loading groups...</p>
                  <div className="loading-spinner"></div>
                </div>
              ) : groups.length === 0 ? (
                <div className="no-groups">
                  <p>No groups found.</p>
                  <button onClick={reloadGroups} className="btn btn-outline">
                    Try Again
                  </button>
                </div>
              ) : (
                <>
                  {groups.slice(0, visibleGroups).map(group => (
                    <div key={group.id} className="group-item">
                      <label className="group-label">
                        <input
                          type="checkbox"
                          checked={selectedGroups.includes(group.id)}
                          onChange={() => toggleGroup(group.id)}
                          disabled={botStatus === 'session_exists'}
                        />
                        <span className="group-name">{group.name}</span>
                        <span className="group-participants">
                          ({group.participants || '...'} participants)
                        </span>
                      </label>
                    </div>
                  ))}
                  
                  {visibleGroups < groups.length && (
                    <div className="load-more">
                      <button onClick={loadMoreGroups} className="btn btn-outline">
                        Load More ({groups.length - visibleGroups} remaining)
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            
            {selectedGroups.length > 0 && (
              <button 
                onClick={saveActiveGroups} 
                disabled={groupsLoading || botStatus === 'session_exists'}
                className="btn btn-success"
              >
                {botStatus === 'session_exists' ? 'Wait for Connection...' : `Save ${selectedGroups.length} Active Groups`}
              </button>
            )}

            {botStatus === 'session_exists' && (
              <div className="info-message">
                <p>📱 <strong>Session detected!</strong> The bot is automatically reconnecting.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default App;