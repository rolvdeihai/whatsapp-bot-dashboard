//src/App.js

import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

function App() {
  const [socket, setSocket] = useState(null);
  const [qrCode, setQrCode] = useState('');
  const [botStatus, setBotStatus] = useState('disconnected');
  const [groups, setGroups] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState(() => {
    // Try to load saved groups from localStorage
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

  useEffect(() => {
    const backendUrl = process.env.REACT_APP_BACKEND_URL;
    const newSocket = io(backendUrl);
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
      
      // Auto-fetch groups when connected
      if (data.status === 'connected') {
        fetchGroups();
      }
      
      // If QR code is included in status update, set it
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

    // Check existing session status on load
    checkSessionStatus();

    return () => newSocket.close();
  }, []);

  const checkSessionStatus = async () => {
    try {
      const response = await fetch('/api/bot-status');
      const data = await response.json();
      console.log('Session status:', data.status);
      setBotStatus(data.status);
      if (data.status === 'connected') {
        fetchGroups();
      }
    } catch (error) {
      console.log('Error checking session status:', error);
    }
  };

  const startBot = () => {
    if (isLoading) return;
    console.log('Manually starting bot');
    setIsLoading(true);
    socket.emit('start-bot');
  };

  const stopBot = () => {
    console.log('Manually stopping bot');
    socket.emit('stop-bot');
    setIsLoading(false);
    setQrCode('');
  };

  const fetchGroups = async () => {
    try {
      const url = '/api/groups';
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const errorText = await response.text();
        console.error('Received non-JSON response:', errorText.substring(0, 200));
        throw new TypeError('Server did not return a JSON response.');
      }
      
      const groupsData = await response.json();
      setGroups(groupsData);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const toggleGroup = (groupId) => {
    setSelectedGroups(prev => {
      const newGroups = prev.includes(groupId)
        ? prev.filter(id => id !== groupId)
        : [...prev, groupId];
      
      localStorage.setItem('activeGroups', JSON.stringify(newGroups));
      return newGroups;
    });
  };

  const saveActiveGroups = async () => {
    try {
      await fetch('/api/active-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groups: selectedGroups
        })
      });
      alert('Active groups updated successfully!');
    } catch (error) {
      console.error('Error saving groups:', error);
    }
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
          <p><em>Bot runs automatically. Use controls below for manual management.</em></p>
          <div className="button-group">
            <button 
              onClick={startBot} 
              disabled={botStatus === 'connected' || botStatus === 'scan_qr' || isLoading}
              className="btn btn-primary"
            >
              {isLoading ? 'Loading...' : 
               botStatus === 'connected' ? 'Connected' : 
               botStatus === 'scan_qr' ? 'Scan QR Code' : 
               botStatus === 'session_exists' ? 'Connect to Existing Session' : 'Start Bot Manually'}
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

        {botStatus === 'connected' && (
          <section className="groups-section">
            <h2>Select Active Groups</h2>
            <p>Choose which groups the bot should respond in:</p>
            
            <div className="groups-list">
              {groups.length === 0 ? (
                <p>Loading groups...</p>
              ) : (
                groups.map(group => (
                  <div key={group.id} className="group-item">
                    <label className="group-label">
                      <input
                        type="checkbox"
                        checked={selectedGroups.includes(group.id)}
                        onChange={() => toggleGroup(group.id)}
                        className="group-checkbox"
                      />
                      <span className="group-name">{group.name}</span>
                      <span className="group-participants">({group.participants} participants)</span>
                    </label>
                  </div>
                ))
              )}
            </div>
            
            <button 
              onClick={saveActiveGroups} 
              disabled={selectedGroups.length === 0 || isLoading}
              className="btn btn-success"
            >
              Save Active Groups ({selectedGroups.length} selected)
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

export default App;