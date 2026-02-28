const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
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
  console.log(`Server running on http://localhost:${PORT}`);
});
