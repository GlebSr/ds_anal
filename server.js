const express = require('express');
const fs = require('fs');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const sslKeyPath = process.env.SSL_KEY_PATH;
const sslCertPath = process.env.SSL_CERT_PATH;
const sslCaPath = process.env.SSL_CA_PATH;
const sslPassphrase = process.env.SSL_PASSPHRASE;

if (!sslKeyPath || !sslCertPath) {
  console.error('Missing SSL_KEY_PATH or SSL_CERT_PATH in .env');
  process.exit(1);
}

const resolvedKeyPath = path.resolve(__dirname, sslKeyPath);
const resolvedCertPath = path.resolve(__dirname, sslCertPath);

if (!fs.existsSync(resolvedKeyPath)) {
  console.error(`SSL key file not found: ${resolvedKeyPath}`);
  process.exit(1);
}

if (!fs.existsSync(resolvedCertPath)) {
  console.error(`SSL cert file not found: ${resolvedCertPath}`);
  process.exit(1);
}

const httpsOptions = {
  key: fs.readFileSync(resolvedKeyPath),
  cert: fs.readFileSync(resolvedCertPath)
};

if (sslCaPath) {
  httpsOptions.ca = fs.readFileSync(path.resolve(__dirname, sslCaPath));
}
if (sslPassphrase) {
  httpsOptions.passphrase = sslPassphrase;
}

const server = https.createServer(httpsOptions, app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Connected users: socketId → { nickname, muted, sharing }
const users = new Map();

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // User joins with a nickname
  socket.on('join', (nickname) => {
    users.set(socket.id, { nickname, muted: false, sharing: false });
    console.log(`${nickname} joined (${socket.id})`);

    // Send the new user the current user list (so they can create peer connections)
    const existingUsers = [];
    for (const [id, user] of users) {
      if (id !== socket.id) {
        existingUsers.push({ id, ...user });
      }
    }
    socket.emit('existing-users', existingUsers);

    // Notify all others about the new user
    socket.broadcast.emit('user-joined', { id: socket.id, nickname, muted: false, sharing: false });
  });

  // WebRTC signaling: relay offer
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  // WebRTC signaling: relay answer
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  // WebRTC signaling: relay ICE candidate
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // Mute status changed
  socket.on('mute-status', (muted) => {
    const user = users.get(socket.id);
    if (user) {
      user.muted = muted;
      socket.broadcast.emit('mute-status', { id: socket.id, muted });
    }
  });

  // Screen sharing started
  socket.on('screen-start', () => {
    const user = users.get(socket.id);
    if (user) {
      user.sharing = true;
      socket.broadcast.emit('screen-start', { id: socket.id, nickname: user.nickname });
    }
  });

  // Screen sharing stopped
  socket.on('screen-stop', () => {
    const user = users.get(socket.id);
    if (user) {
      user.sharing = false;
      socket.broadcast.emit('screen-stop', { id: socket.id });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`${user.nickname} left (${socket.id})`);
      users.delete(socket.id);
      socket.broadcast.emit('user-left', { id: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on https://localhost:${PORT}`);
});
