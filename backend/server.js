const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());

const MAX_CHUNK = 256 * 1024;
const mediaCache = new Map();

let client;
let stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');
const sessionFile = path.join('/tmp', 'telegram-session.txt');

if (fs.existsSync(sessionFile)) {
  const savedSession = fs.readFileSync(sessionFile, 'utf8').trim();
  if (savedSession) {
    stringSession = new StringSession(savedSession);
  }
}

function persistSession() {
  try {
    const sessionString = client && client.session ? client.session.save() : '';
    if (sessionString) {
      fs.writeFileSync(sessionFile, sessionString);
    }
  } catch (err) {
    console.error('Session persist error:', err.message);
  }
}

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
      useWSS: true,
      timeout: 8,
      requestRetries: 2,
      autoReconnect: true,
      baseLogger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {}
      }
    }
  );

  await client.connect();
  persistSession();
  return client;
}

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value);
}

function cacheKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

async function getVideoMessage(chatId, messageId) {
  const key = cacheKey(chatId, messageId);
  const cached = mediaCache.get(key);
  if (cached && cached.message && cached.message.media) {
    return cached;
  }

  const messages = await client.getMessages(chatId, { ids: Number(messageId) });
  if (!messages.length || !messages[0].media || !messages[0].media.document) {
    return null;
  }

  const message = messages[0];
  const document = message.media.document;
  const entry = {
    message,
    document,
    fileSize: toNumber(document.size),
    mimeType: document.mimeType || 'video/mp4'
  };
  mediaCache.set(key, entry);
  return entry;
}

async function downloadRange(message, start, end) {
  const buffer = await client.downloadMedia(message, {
    start,
    end,
    workers: 1
  });
  if (Buffer.isBuffer(buffer)) return buffer;
  if (buffer instanceof Uint8Array) return Buffer.from(buffer);
  if (!buffer) return Buffer.alloc(0);
  return Buffer.from(buffer);
}

function sendRangeHeaders(res, start, end, fileSize, mimeType, length) {
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': length,
    'Content-Type': mimeType,
    'Cache-Control': 'private, max-age=30',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
  });
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'vidgram-backend', api: '/api' });
});

app.get('/api', (req, res) => {
  res.json({
    ok: true,
    endpoints: ['/api/check-auth', '/api/login', '/api/logout', '/api/dialogs', '/api/videos/:chatId', '/api/stream/:chatId/:messageId']
  });
});

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

    persistSession();
    const sessionString = client.session.save();
    res.json({ success: true, sessionString });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    mediaCache.clear();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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

app.get('/api/videos/:chatId', async (req, res) => {
  try {
    await initTelegram();
    const { chatId } = req.params;
    const offsetId = Number(req.query.offsetId || 0);
    const limit = Math.min(Number(req.query.limit || 24), 40);

    const messages = await client.getMessages(chatId, {
      limit,
      offsetId,
      filter: { _: 'inputMessagesFilterVideo' }
    });

    const videos = messages
      .filter(msg => msg.media && msg.media.document)
      .map(msg => {
        const document = msg.media.document;
        const videoAttr = document.attributes.find(attr => attr.className === 'DocumentAttributeVideo' || attr._ === 'documentAttributeVideo');
        const filenameAttr = document.attributes.find(attr => attr.className === 'DocumentAttributeFilename' || attr._ === 'documentAttributeFilename');
        mediaCache.set(cacheKey(chatId, msg.id), {
          message: msg,
          document,
          fileSize: toNumber(document.size),
          mimeType: document.mimeType || 'video/mp4'
        });
        return {
          id: msg.id,
          date: msg.date,
          caption: msg.message || '',
          duration: videoAttr?.duration || 0,
          width: videoAttr?.w || 0,
          height: videoAttr?.h || 0,
          size: toNumber(document.size),
          mimeType: document.mimeType || 'video/mp4',
          fileName: filenameAttr?.fileName || `video_${msg.id}.mp4`
        };
      });

    const lastId = messages.length ? messages[messages.length - 1].id : offsetId;
    res.json({
      success: true,
      videos,
      hasMore: messages.length === limit,
      nextOffsetId: lastId
    });
  } catch (error) {
    console.error('Get videos error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function handleStream(req, res) {
  try {
    await initTelegram();
    const { chatId, messageId } = req.params;
    const media = await getVideoMessage(chatId, messageId);
    if (!media) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const fileSize = media.fileSize;
    const mimeType = media.mimeType;

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Cache-Control': 'private, max-age=30'
      });
      return res.end();
    }

    let start = 0;
    let end = Math.min(MAX_CHUNK - 1, fileSize - 1);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      start = parseInt(parts[0], 10) || 0;
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : start + MAX_CHUNK - 1;
      end = Math.min(requestedEnd, start + MAX_CHUNK - 1, fileSize - 1);
    }

    if (start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const buffer = await downloadRange(media.message, start, end);
    const actualEnd = start + buffer.length - 1;
    sendRangeHeaders(res, start, actualEnd, fileSize, mimeType, buffer.length);
    res.end(buffer);
  } catch (error) {
    console.error('Streaming error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
}

app.head('/api/stream/:chatId/:messageId', handleStream);
app.get('/api/stream/:chatId/:messageId', handleStream);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
  });
}

module.exports = app;
