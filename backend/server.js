const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());

let client;
let stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');

// Session management
let sessionFile = path.join('/tmp', 'telegram-session.txt');
const fs = require('fs');

// Load existing session if available
if (fs.existsSync(sessionFile)) {
  const savedSession = fs.readFileSync(sessionFile, 'utf8').trim();
  if (savedSession) {
    stringSession = new StringSession(savedSession);
  }
}

// Initialize Telegram client
async function initTelegram() {
  if (client && client.connected) {
    return client;
  }
  
  client = new TelegramClient(
    stringSession,
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { 
      connectionRetries: 5,
      baseLogger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {}
      }
    }
  );
  
  await client.connect();
  
  // Save session
  const sessionString = client.session.save();
  if (sessionString) {
    fs.writeFileSync(sessionFile, sessionString);
  }
  
  console.log('Telegram client connected');
  return client;
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'vidgram-backend',
    api: '/api'
  });
});

app.get('/api', (req, res) => {
  res.json({
    ok: true,
    endpoints: ['/api/check-auth', '/api/login', '/api/logout', '/api/dialogs', '/api/videos/:chatId', '/api/stream/:chatId/:messageId']
  });
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { phoneNumber, phoneCode, phoneCodeHash, password } = req.body;
    
    if (!client || !client.connected) {
      await initTelegram();
    }
    
    if (phoneCode) {
      await client.invoke({
        _: 'auth.signIn',
        phoneNumber,
        phoneCodeHash,
        phoneCode
      });
    } else if (password) {
      await client.invoke({
        _: 'auth.checkPassword',
        password: { _: 'inputCheckPasswordSRP', srpId: req.body.srpId, A: req.body.A, M1: req.body.M1 }
      });
    } else {
      const result = await client.invoke({
        _: 'auth.sendCode',
        phoneNumber,
        apiId: Number(process.env.TELEGRAM_API_ID),
        apiHash: process.env.TELEGRAM_API_HASH,
        settings: { _: 'codeSettings' }
      });
      
      return res.json({ 
        success: true, 
        phoneCodeHash: result.phoneCodeHash,
        timeout: result.timeout
      });
    }
    
    const sessionString = client.session.save();
    if (sessionString) {
      fs.writeFileSync(sessionFile, sessionString);
    }
    
    res.json({ success: true, sessionString });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check if already logged in
app.get('/api/check-auth', async (req, res) => {
  try {
    if (process.env.TELEGRAM_SESSION || fs.existsSync(sessionFile)) {
      if (fs.existsSync(sessionFile)) {
        const savedSession = fs.readFileSync(sessionFile, 'utf8').trim();
        if (savedSession) {
          stringSession = new StringSession(savedSession);
        }
      }
      await initTelegram();
      const me = await client.getMe();
      return res.json({ 
        success: true, 
        loggedIn: true,
        user: { id: me.id.toString(), username: me.username, firstName: me.firstName }
      });
    }
    res.json({ success: true, loggedIn: false });
  } catch (error) {
    res.json({ success: true, loggedIn: false });
  }
});

// Logout endpoint
app.post('/api/logout', async (req, res) => {
  try {
    if (client && client.connected) {
      await client.invoke({ _: 'auth.logOut' });
      await client.disconnect();
    }
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
    }
    client = null;
    stringSession = new StringSession('');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all dialogs (channels, groups, chats)
app.get('/api/dialogs', async (req, res) => {
  try {
    await initTelegram();
    
    const dialogs = await client.getDialogs({ limit: 100 });
    
    const result = dialogs
      .filter(dialog => dialog.isChannel || dialog.isGroup)
      .map(dialog => ({
        id: dialog.id.toString(),
        title: dialog.title,
        type: dialog.isChannel ? 'channel' : 'group',
        unreadCount: dialog.unreadCount,
        participantsCount: dialog.entity.participantsCount || 0
      }));
    
    res.json({ success: true, dialogs: result });
  } catch (error) {
    console.error('Get dialogs error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get videos from a specific channel/group
app.get('/api/videos/:chatId', async (req, res) => {
  try {
    await initTelegram();
    
    const { chatId } = req.params;
    const { offsetId = 0, limit = 50 } = req.query;
    
    const messages = await client.getMessages(chatId, {
      limit: Number(limit),
      offsetId: Number(offsetId),
      filter: { _: 'inputMessagesFilterVideo' }
    });
    
    const videos = messages
      .filter(msg => msg.media && msg.media.document)
      .map(msg => {
        const videoAttr = msg.media.document.attributes.find(attr => attr._ === 'documentAttributeVideo');
        const filenameAttr = msg.media.document.attributes.find(attr => attr._ === 'documentAttributeFilename');
        
        return {
          id: msg.id,
          date: msg.date,
          caption: msg.message || '',
          duration: videoAttr?.duration || 0,
          width: videoAttr?.w || 0,
          height: videoAttr?.h || 0,
          size: msg.media.document.size,
          mimeType: msg.media.document.mimeType,
          fileName: filenameAttr?.fileName || `video_${msg.id}.mp4`
        };
      });
    
    res.json({ 
      success: true, 
      videos,
      hasMore: messages.length === Number(limit)
    });
  } catch (error) {
    console.error('Get videos error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stream video content
app.get('/api/stream/:chatId/:messageId', async (req, res) => {
  try {
    await initTelegram();
    
    const { chatId, messageId } = req.params;
    const range = req.headers.range;
    
    const messages = await client.getMessages(chatId, {
      ids: Number(messageId)
    });
    
    if (!messages.length || !messages[0].media) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    const message = messages[0];
    const document = message.media.document;
    const fileSize = document.size;
    
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      
      const buffer = await client.downloadMedia(message, {
        start,
        end
      });
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': document.mimeType || 'video/mp4'
      });
      
      res.end(buffer);
    } else {
      const buffer = await client.downloadMedia(message);
      
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': document.mimeType || 'video/mp4',
        'Accept-Ranges': 'bytes'
      });
      
      res.end(buffer);
    }
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
  });
}

module.exports = app;
