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
    if (savedGroups) {
      try {
        return JSON.parse(savedGroups);
      } catch (error) {
        console.error('Error parsing saved groups:', error);
      }
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [visibleGroups, setVisibleGroups] = useState(20);

  // 🚀 FIX: Use refs to track state without causing re-renders
  const selectedGroupsRef = useRef(selectedGroups);
  const groupsLoadedRef = useRef(false);

  // Update ref when selectedGroups changes
  useEffect(() => {
    selectedGroupsRef.current = selectedGroups;
  }, [selectedGroups]);

  // 🚀 FIX: Stable fetch function that doesn't change
  const fetchGroupsPreview = async () => {
    if (groupsLoading) return;
    
    setGroupsLoading(true);
    try {
      console.log('🚀 Fetching groups preview (fast load)...');
      const response = await fetch(`${backendUrl}/api/groups/preview`);
      
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new TypeError('Server did not return JSON');
      }
      
      const previewData = await response.json();
      setGroups(previewData);
      console.log(`✅ Loaded ${previewData.length} groups preview`);
      
      // 🚀 PERFORMANCE: Load details for selected groups only
      if (selectedGroupsRef.current.length > 0) {
        loadSelectedGroupsDetails(selectedGroupsRef.current);
      }

      groupsLoadedRef.current = true;
    } catch (error) {
      console.error('Error fetching groups preview:', error);
      // Fallback to regular endpoint
      await fetchGroups();
    } finally {
      setGroupsLoading(false);
    }
  };

  const loadSelectedGroupsDetails = async (groupIds) => {
    try {
      console.log(`🔍 Loading details for ${groupIds.length} selected groups...`);
      const response = await fetch(`${backendUrl}/api/groups/details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds }),
      });

      if (response.ok) {
        const detailedGroups = await response.json();
        
        // Update groups with detailed information
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

  const fetchGroups = async () => {
    setGroupsLoading(true);
    try {
      console.log('🔄 Fetching full groups list...');
      const response = await fetch(`${backendUrl}/api/groups`);
      
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new TypeError('Server did not return JSON');
      }
      
      const groupsData = await response.json();
      setGroups(groupsData);
      console.log(`✅ Loaded ${groupsData.length} groups`);
      groupsLoadedRef.current = true;
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setGroupsLoading(false);
    }
  };

  // 🚀 FIX: Socket connection - runs only once
  useEffect(() => {
    const newSocket = io(backendUrl, {
      transports: ['websocket', 'polling'] // 🚀 FIX: Specify transports
    });
    setSocket(newSocket);

    newSocket.on('qr-code', (data) => {
      console.log('QR code received:', data.qr ? 'Base64 data received' : 'No data');
      setQrCode(data.qr);
      setIsLoading(false);
    });

    newSocket.on('bot-status', (data) => {
      console.log('Bot status:', data.status);
      setBotStatus(data.status);
      setIsLoading(false);
      
      if (data.qrCode) {
        setQrCode(data.qrCode);
      }
    });

    newSocket.on('active-groups-updated', (data) => {
      console.log('Active groups updated from server:', data.groups);
      setSelectedGroups(data.groups);
      localStorage.setItem('activeGroups', JSON.stringify(data.groups));
    });

    newSocket.on('bot-error', (data) => {
      console.error('Bot error:', data.error);
      alert('Bot error: ' + data.error);
      setIsLoading(false);
    });

    newSocket.on('connect', () => {
      console.log('✅ Socket connected');
    });

    newSocket.on('disconnect', () => {
      console.log('🔌 Socket disconnected');
    });

    return () => {
      newSocket.close();
    };
  }, []); // 🚀 FIX: Empty dependency array

  // 🚀 FIX: Load groups based on status - with proper guards
  useEffect(() => {
    const loadGroupsIfNeeded = async () => {
      // Don't load if already loading or already loaded
      if (groupsLoading || groupsLoadedRef.current) {
        return;
      }

      // Only load for these statuses
      if (botStatus === 'connected' || botStatus === 'session_exists') {
        console.log(`🔄 Loading groups for status: ${botStatus}`);
        await fetchGroupsPreview();
      }
    };

    loadGroupsIfNeeded();
  }, [botStatus]); // 🚀 FIX: Only depend on botStatus

  // 🚀 FIX: Initial session check - runs only once
  useEffect(() => {
    const checkSessionStatus = async () => {
      try {
        const response = await fetch(`${backendUrl}/api/bot-status`);
        const data = await response.json();
        console.log('Initial session status:', data.status);
        setBotStatus(data.status);
      } catch (error) {
        console.log('Error checking session status:', error);
      }
    };

    checkSessionStatus();
  }, []);

  // 🚀 FIX: Reset groups loaded flag when bot disconnects
  useEffect(() => {
    if (botStatus === 'disconnected') {
      groupsLoadedRef.current = false;
      setGroups([]); // Clear groups when disconnected
    }
  }, [botStatus]);

  const startBot = () => {
    if (isLoading) return;
    console.log('Manually starting bot');
    setIsLoading(true);
    if (socket) {
      socket.emit('start-bot');
    }
  };

  const stopBot = () => {
    console.log('Manually stopping bot');
    if (socket) {
      socket.emit('stop-bot');
    }
    setIsLoading(false);
    setQrCode('');
    groupsLoadedRef.current = false;
    setGroups([]);
  };

  const toggleGroup = async (groupId) => {
    const newSelectedGroups = selectedGroups.includes(groupId)
      ? selectedGroups.filter(id => id !== groupId)
      : [...selectedGroups, groupId];
    
    setSelectedGroups(newSelectedGroups);
    localStorage.setItem('activeGroups', JSON.stringify(newSelectedGroups));

    // 🚀 PERFORMANCE: Load details for newly selected group
    if (!selectedGroups.includes(groupId)) {
      await loadSelectedGroupsDetails([groupId]);
    }
  };

  const saveActiveGroups = async () => {
    try {
      await fetch(`${backendUrl}/api/active-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: selectedGroups }),
      });
      alert('Active groups updated successfully!');
    } catch (error) {
      console.error('Error saving groups:', error);
    }
  };

  const refreshGroups = async () => {
    groupsLoadedRef.current = false;
    await fetchGroupsPreview();
  };

  const reloadGroups = async () => {
    groupsLoadedRef.current = false;
    await fetchGroupsPreview();
  };

  const loadMoreGroups = () => {
    setVisibleGroups(prev => prev + 20);
  };

  // 🚀 LAZY LOADING: Infinite scroll implementation
  useEffect(() => {
    const handleScroll = () => {
      if (window.innerHeight + document.documentElement.scrollTop 
          !== document.documentElement.offsetHeight) return;
      
      if (visibleGroups < groups.length) {
        loadMoreGroups();
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [visibleGroups, groups.length]);

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
          <p><em>Bot runs automatically. Use controls below for manual management.</em></p>
          <div className="button-group">
            <button 
              onClick={startBot} 
              disabled={botStatus === 'connected' || botStatus === 'scan_qr' || isLoading || botStatus === 'session_exists'}
              className="btn btn-primary"
            >
              {isLoading ? 'Loading...' : 
               botStatus === 'connected' ? 'Connected' : 
               botStatus === 'scan_qr' ? 'Scan QR Code' : 
               botStatus === 'session_exists' ? 'Auto-Connecting...' : 'Start Bot Manually'}
            </button>
            
            {botStatus === 'connected' && (
              <button onClick={stopBot} className="btn btn-danger" disabled={isLoading}>
                Stop Bot
              </button>
            )}
          </div>
          
          {qrCode && botStatus === 'scan_qr' && (
            <div className="qr-code">
              <p>Scan this QR code with WhatsApp to connect:</p>
              <img src={qrCode} alt="QR Code" style={{ width: '300px', height: '300px' }} />
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
                  {groupsLoading ? 'Loading...' : 'Reload Groups'}
                </button>
                <button 
                  onClick={refreshGroups}
                  disabled={groupsLoading}
                  className="btn btn-outline"
                >
                  Refresh Cache
                </button>
              </div>
            </div>
            
            <p>Choose which groups the bot should respond in:</p>
            
            <div className="groups-list">
              {groupsLoading ? (
                <div className="loading-groups">
                  <p>Loading groups...</p>
                  <div className="loading-spinner"></div>
                </div>
              ) : groups.length === 0 ? (
                <p>No groups found or still loading...</p>
              ) : (
                <>
                  {groups.slice(0, visibleGroups).map(group => (
                    <div key={group.id} className="group-item">
                      <label className="group-label">
                        <input
                          type="checkbox"
                          checked={selectedGroups.includes(group.id)}
                          onChange={() => toggleGroup(group.id)}
                          className="group-checkbox"
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
                    <div className="load-more-container">
                      <button onClick={loadMoreGroups} className="btn btn-outline">
                        Load More ({groups.length - visibleGroups} remaining)
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            
            <button 
              onClick={saveActiveGroups} 
              disabled={selectedGroups.length === 0 || groupsLoading || botStatus === 'session_exists'}
              className="btn btn-success"
            >
              {botStatus === 'session_exists' ? 'Wait for Connection...' : `Save Active Groups (${selectedGroups.length} selected)`}
            </button>

            {botStatus === 'session_exists' && (
              <div className="info-message">
                <p>📱 <strong>Session detected!</strong> The bot is automatically reconnecting. Groups will be available once connected.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export default App;