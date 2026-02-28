/**
 * app.js — UI controller, binds DOM to WebRTCManager + Socket.io
 */

(function () {
  /* ===== DOM refs ===== */
  const loginScreen    = document.getElementById('login-screen');
  const roomScreen     = document.getElementById('room-screen');
  const loginForm      = document.getElementById('login-form');
  const nicknameInput  = document.getElementById('nickname-input');
  const usersList      = document.getElementById('users-list');
  const userCountEl    = document.getElementById('user-count');
  const myNicknameEl   = document.getElementById('my-nickname');
  const btnMic         = document.getElementById('btn-mic');
  const btnScreen      = document.getElementById('btn-screen');
  const btnLeave       = document.getElementById('btn-leave');
  const screenVideo    = document.getElementById('screen-video');
  const screenPlaceholder = document.getElementById('screen-placeholder');
  const screenLabel    = document.getElementById('screen-label');
  const screenSharerName = document.getElementById('screen-sharer-name');

  /* ===== State ===== */
  let socket = null;
  let rtc = null;
  let myNickname = '';
  /** @type {Map<string, {nickname: string, muted: boolean, sharing: boolean}>} */
  const usersMap = new Map();

  /* ===== Login ===== */
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    myNickname = nicknameInput.value.trim();
    if (!myNickname) return;

    // Connect to signaling server
    socket = io();
    rtc = new WebRTCManager(socket);

    // Setup remote screen callbacks
    rtc.onRemoteScreen = (stream, peerId) => {
      screenVideo.srcObject = stream;
      screenVideo.classList.remove('hidden');
      screenPlaceholder.classList.add('hidden');
      const user = usersMap.get(peerId);
      screenSharerName.textContent = user ? user.nickname : 'Кто-то';
      screenLabel.classList.remove('hidden');
    };
    rtc.onScreenStopped = (_peerId) => {
      hideScreenShare();
    };

    // Init microphone
    await rtc.initLocalAudio();

    // Listen for server events
    setupSocketListeners();

    // Join
    socket.emit('join', myNickname);

    // Switch screens
    loginScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    myNicknameEl.textContent = myNickname;
  });

  /* ===== Socket event listeners ===== */
  function setupSocketListeners() {
    // Receive list of existing users → connect to each
    socket.on('existing-users', async (users) => {
      for (const user of users) {
        usersMap.set(user.id, { nickname: user.nickname, muted: user.muted, sharing: user.sharing });
        await rtc.connectToPeer(user.id);
        // If someone was already sharing
        if (user.sharing) {
          screenSharerName.textContent = user.nickname;
        }
      }
      renderUsers();
    });

    // New user joined
    socket.on('user-joined', async (user) => {
      usersMap.set(user.id, { nickname: user.nickname, muted: user.muted, sharing: user.sharing });
      renderUsers();
      // The new user will send us an offer, so we wait (they are the initiator)
    });

    // User left
    socket.on('user-left', ({ id }) => {
      usersMap.delete(id);
      rtc.removePeer(id);
      renderUsers();
      // If the leaving user was sharing screen, hide it
      if (screenVideo.srcObject) {
        // Check if the stream is still active
        const tracks = screenVideo.srcObject.getTracks();
        const allEnded = tracks.every(t => t.readyState === 'ended');
        if (allEnded) hideScreenShare();
      }
    });

    // Mute status update
    socket.on('mute-status', ({ id, muted }) => {
      const user = usersMap.get(id);
      if (user) {
        user.muted = muted;
        renderUsers();
      }
    });

    // Screen share started
    socket.on('screen-start', ({ id, nickname }) => {
      const user = usersMap.get(id);
      if (user) {
        user.sharing = true;
        renderUsers();
      }
    });

    // Screen share stopped
    socket.on('screen-stop', ({ id }) => {
      const user = usersMap.get(id);
      if (user) {
        user.sharing = false;
        renderUsers();
      }
      hideScreenShare();
    });
  }

  /* ===== Controls ===== */
  btnMic.addEventListener('click', () => {
    if (!rtc) return;
    const muted = rtc.toggleMute();
    btnMic.classList.toggle('muted', muted);
    btnMic.querySelector('.icon-mic-on').classList.toggle('hidden', muted);
    btnMic.querySelector('.icon-mic-off').classList.toggle('hidden', !muted);
  });

  btnScreen.addEventListener('click', async () => {
    if (!rtc) return;
    if (rtc.isSharing) {
      await rtc.stopScreenShare();
      btnScreen.classList.remove('active');
      hideScreenShare();
    } else {
      const ok = await rtc.startScreenShare();
      if (ok) {
        btnScreen.classList.add('active');
        // Show own screen locally
        screenVideo.srcObject = rtc.screenStream;
        screenVideo.classList.remove('hidden');
        screenPlaceholder.classList.add('hidden');
        screenSharerName.textContent = myNickname + ' (ты)';
        screenLabel.classList.remove('hidden');
      }
    }
  });

  btnLeave.addEventListener('click', () => {
    leave();
  });

  /* ===== Helpers ===== */
  function renderUsers() {
    usersList.innerHTML = '';
    // Add self first
    const selfLi = createUserLi('self', myNickname, rtc ? rtc.isMuted : false, rtc ? rtc.isSharing : false);
    usersList.appendChild(selfLi);

    for (const [id, user] of usersMap) {
      const li = createUserLi(id, user.nickname, user.muted, user.sharing);
      usersList.appendChild(li);
    }
    userCountEl.textContent = usersMap.size + 1;
  }

  function createUserLi(id, nickname, muted, sharing) {
    const li = document.createElement('li');
    li.className = 'user-item';
    li.dataset.userId = id;

    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.textContent = nickname.charAt(0).toUpperCase();

    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = nickname + (id === 'self' ? ' (ты)' : '');

    li.appendChild(avatar);
    li.appendChild(name);

    // Screen icon
    if (sharing) {
      const screenIcon = document.createElement('span');
      screenIcon.className = 'user-screen-icon';
      screenIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`;
      screenIcon.title = 'Транслирует экран';
      li.appendChild(screenIcon);
    }

    // Mic icon
    const micIcon = document.createElement('span');
    micIcon.className = 'user-mic-icon' + (muted ? ' muted' : '');
    if (muted) {
      micIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="1" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4M8 21h8"/><line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2.5"/></svg>`;
      micIcon.title = 'Микрофон выключен';
    } else {
      micIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="1" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4M8 21h8"/></svg>`;
      micIcon.title = 'Микрофон включён';
    }
    li.appendChild(micIcon);

    return li;
  }

  function hideScreenShare() {
    screenVideo.srcObject = null;
    screenVideo.classList.add('hidden');
    screenPlaceholder.classList.remove('hidden');
    screenLabel.classList.add('hidden');
  }

  function leave() {
    if (rtc) {
      rtc.destroy();
      rtc = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    usersMap.clear();
    hideScreenShare();
    btnScreen.classList.remove('active');
    btnMic.classList.remove('muted');
    btnMic.querySelector('.icon-mic-on').classList.remove('hidden');
    btnMic.querySelector('.icon-mic-off').classList.add('hidden');
    roomScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    nicknameInput.value = '';
  }

  // Cleanup on tab close
  window.addEventListener('beforeunload', () => {
    if (rtc) rtc.destroy();
    if (socket) socket.disconnect();
  });
})();
