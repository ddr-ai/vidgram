import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

function App() {
  const [dialogs, setDialogs] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [videos, setVideos] = useState([]);
  const [currentVideo, setCurrentVideo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffsetId, setNextOffsetId] = useState(0);
  const [error, setError] = useState(null);
  const [loginStep, setLoginStep] = useState('loading');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [password, setPassword] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [user, setUser] = useState(null);

  const cacheRef = useRef({});
  const loadMoreRef = useRef(null);
  const selectedChatRef = useRef(null);
  const videoRef = useRef(null);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const response = await axios.get(`${API_URL}/check-auth`);
      if (response.data.loggedIn) {
        setUser(response.data.user);
        setLoginStep('loggedIn');
        fetchDialogs();
      } else {
        setLoginStep('phone');
      }
    } catch (err) {
      setLoginStep('phone');
    }
  };

  const handleLogin = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.post(`${API_URL}/login`, {
        phoneNumber,
        phoneCode,
        phoneCodeHash,
        password
      });
      if (response.data.phoneCodeHash) {
        setPhoneCodeHash(response.data.phoneCodeHash);
        setLoginStep('code');
      } else if (response.data.success) {
        setLoginStep('loggedIn');
        fetchDialogs();
        checkAuth();
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
      if (err.response?.status === 500 && err.response?.data?.error?.includes('PASSWORD')) {
        setLoginStep('password');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await axios.post(`${API_URL}/logout`);
      cacheRef.current = {};
      setLoginStep('phone');
      setDialogs([]);
      setVideos([]);
      setCurrentVideo(null);
      setUser(null);
      setPhoneNumber('');
      setPhoneCode('');
      setPassword('');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const fetchDialogs = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await axios.get(`${API_URL}/dialogs`);
      setDialogs(response.data.dialogs || []);
    } catch (err) {
      setError('Failed to fetch channels and groups');
    } finally {
      setLoading(false);
    }
  };

  const applyPage = (chatId, pageVideos, pageHasMore, pageOffset, append) => {
    setVideos(prev => {
      const merged = append
        ? [...prev, ...pageVideos.filter(v => !prev.some(p => p.id === v.id))]
        : pageVideos;
      cacheRef.current[chatId] = {
        videos: merged,
        hasMore: pageHasMore,
        nextOffsetId: pageOffset
      };
      return merged;
    });
    setHasMore(pageHasMore);
    setNextOffsetId(pageOffset);
  };

  const fetchVideos = async (chatId, { append = false, offsetId = 0 } = {}) => {
    selectedChatRef.current = chatId;
    setSelectedChat(chatId);
    setError(null);

    const cached = cacheRef.current[chatId];
    if (!append && cached && cached.videos.length) {
      setVideos(cached.videos);
      setHasMore(cached.hasMore);
      setNextOffsetId(cached.nextOffsetId);
    } else if (!append) {
      setVideos([]);
      setHasMore(false);
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const response = await axios.get(`${API_URL}/videos/${chatId}`, {
        params: { offsetId, limit: 24 }
      });
      if (selectedChatRef.current !== chatId) return;
      applyPage(
        chatId,
        response.data.videos || [],
        Boolean(response.data.hasMore),
        response.data.nextOffsetId || 0,
        append
      );
    } catch (err) {
      if (selectedChatRef.current === chatId) {
        setError('Failed to fetch videos');
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const loadMore = useCallback(() => {
    if (!selectedChat || !hasMore || loading || loadingMore) return;
    fetchVideos(selectedChat, { append: true, offsetId: nextOffsetId });
  }, [selectedChat, hasMore, loading, loadingMore, nextOffsetId]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '600px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, videos.length]);

  const playVideo = video => {
    setCurrentVideo(video);
  };

  const streamUrl = currentVideo && selectedChat
    ? `${API_URL}/stream/${selectedChat}/${currentVideo.id}`
    : '';

  const formatDuration = seconds => {
    if (!seconds) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const formatFileSize = bytes => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDate = timestamp => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const filteredDialogs = dialogs.filter(dialog =>
    dialog.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loginStep === 'loading') {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  if (loginStep !== 'loggedIn') {
    return (
      <div className="login-container">
        <div className="login-box">
          <div className="login-header">
            <h1>📺 Telegram Media Viewer</h1>
            <p>Watch videos from your channels and groups</p>
          </div>
          {error && <div className="error-message">{error}</div>}
          {loginStep === 'phone' && (
            <div className="login-form">
              <h2>Login to Telegram</h2>
              <input
                type="text"
                placeholder="Phone number (e.g., +1234567890)"
                value={phoneNumber}
                onChange={e => setPhoneNumber(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleLogin()}
              />
              <button onClick={handleLogin} disabled={loading || !phoneNumber}>
                {loading ? 'Sending Code...' : 'Send Code'}
              </button>
            </div>
          )}
          {loginStep === 'code' && (
            <div className="login-form">
              <h2>Enter Verification Code</h2>
              <p className="helper-text">Code sent to {phoneNumber}</p>
              <input
                type="text"
                placeholder="Enter code"
                value={phoneCode}
                onChange={e => setPhoneCode(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleLogin()}
              />
              <button onClick={handleLogin} disabled={loading || !phoneCode}>
                {loading ? 'Verifying...' : 'Verify'}
              </button>
              <button className="secondary-btn" onClick={() => setLoginStep('phone')}>Back</button>
            </div>
          )}
          {loginStep === 'password' && (
            <div className="login-form">
              <h2>Enter Password</h2>
              <p className="helper-text">2FA is enabled for this account</p>
              <input
                type="password"
                placeholder="Enter 2FA password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleLogin()}
              />
              <button onClick={handleLogin} disabled={loading || !password}>
                {loading ? 'Checking...' : 'Login'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>📺 Channels & Groups</h2>
          {user && (
            <div className="user-info">
              <span className="user-avatar">{user.firstName?.charAt(0) || 'U'}</span>
              <span className="user-name">{user.firstName || user.username}</span>
              <button className="logout-btn" onClick={handleLogout} title="Logout">⏻</button>
            </div>
          )}
        </div>
        <div className="search-box">
          <input
            type="text"
            placeholder="Search channels..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="dialogs-list">
          {filteredDialogs.map(dialog => (
            <div
              key={dialog.id}
              className={`dialog-item ${selectedChat === dialog.id ? 'active' : ''}`}
              onClick={() => fetchVideos(dialog.id)}
            >
              <div className="dialog-avatar">{dialog.title.charAt(0).toUpperCase()}</div>
              <div className="dialog-info">
                <div className="dialog-title">{dialog.title}</div>
                <div className="dialog-meta">
                  {dialog.type === 'channel' ? '📢 Channel' : '👥 Group'}
                  {dialog.participantsCount > 0 && ` • ${dialog.participantsCount.toLocaleString()} members`}
                </div>
              </div>
            </div>
          ))}
          {filteredDialogs.length === 0 && !loading && (
            <div className="empty-state">No channels or groups found</div>
          )}
        </div>
      </div>

      <div className="main-content">
        <div className="videos-section">
          <div className="videos-header">
            <h2>
              {selectedChat
                ? `🎬 Videos in ${dialogs.find(d => d.id === selectedChat)?.title || ''}`
                : 'Select a channel or group to view videos'}
            </h2>
            {videos.length > 0 && <span className="video-count">{videos.length}{hasMore ? '+' : ''} videos</span>}
          </div>
          {error && <div className="error-message">{error}</div>}
          {loading && videos.length === 0 && (
            <div className="loading-overlay"><div className="spinner"></div></div>
          )}
          <div className="videos-grid">
            {videos.map(video => (
              <div
                key={video.id}
                className={`video-card ${currentVideo?.id === video.id ? 'selected' : ''}`}
                onClick={() => playVideo(video)}
              >
                <div className="video-thumbnail">
                  <div className="play-icon">▶</div>
                  {video.duration > 0 && (
                    <span className="duration-badge">{formatDuration(video.duration)}</span>
                  )}
                  {video.height > 0 && <span className="quality-badge">{video.height}p</span>}
                </div>
                <div className="video-info">
                  <div className="video-caption">{video.caption || video.fileName}</div>
                  <div className="video-meta">{formatFileSize(video.size)} • {formatDate(video.date)}</div>
                </div>
              </div>
            ))}
            {videos.length === 0 && !loading && selectedChat && (
              <div className="empty-state">No videos found in this chat</div>
            )}
          </div>
          <div ref={loadMoreRef} className="load-more-sentinel">
            {loadingMore && <div className="spinner"></div>}
            {!loadingMore && hasMore && selectedChat && (
              <button className="load-more-btn" onClick={loadMore}>Load more videos</button>
            )}
          </div>
        </div>

        {currentVideo && (
          <div className="player-section">
            <div className="player-header">
              <h3>🎥 {currentVideo.caption || currentVideo.fileName}</h3>
              <button className="close-btn" onClick={() => setCurrentVideo(null)}>✕</button>
            </div>
            <div className="player-wrapper">
              <video
                key={streamUrl}
                ref={videoRef}
                src={streamUrl}
                controls
                autoPlay
                playsInline
                preload="auto"
                controlsList="nodownload"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
