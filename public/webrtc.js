/**
 * webrtc.js — WebRTC connection management (voice + screen sharing)
 *
 * Exposes a global `WebRTCManager` class used by app.js.
 */

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    /** @type {Map<string, {pc: RTCPeerConnection, audioEl: HTMLAudioElement}>} */
    this.peers = new Map();
    this.localStream = null;       // microphone stream
    this.screenStream = null;      // screen capture stream
    this.isMuted = false;
    this.isSharing = false;

    // Callbacks (set by app.js)
    this.onRemoteScreen = null;    // (stream, peerId) => void
    this.onScreenStopped = null;   // (peerId) => void

    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];

    this._setupSignaling();
  }

  /* ========== Microphone ========== */

  async initLocalAudio() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('mediaDevices.getUserMedia is unavailable (HTTPS required or unsupported browser).');
      }
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Microphone access denied:', err);
      // Create a silent stream so connections still work
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const dest = ctx.createMediaStreamDestination();
      this.localStream = dest.stream;
    }
  }

  toggleMute() {
    if (!this.localStream) return false;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(t => (t.enabled = !this.isMuted));
    this.socket.emit('mute-status', this.isMuted);
    return this.isMuted;
  }

  /* ========== Screen sharing ========== */

  async startScreenShare() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error('mediaDevices.getDisplayMedia is unavailable (HTTPS required or unsupported browser).');
      }
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 60 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        }
      });
    } catch (err) {
      console.warn('Screen share cancelled:', err);
      return false;
    }

    // Hint the video track for sharp text / detail rendering
    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'detail';
    }

    this.isSharing = true;
    this.socket.emit('screen-start');

    // Add screen tracks to every peer connection
    for (const [peerId, { pc }] of this.peers) {
      this.screenStream.getTracks().forEach(track => {
        pc.addTrack(track, this.screenStream);
      });
      // Boost video bitrate for this peer
      await this._setVideoBitrate(pc);
      // Renegotiate
      await this._createAndSendOffer(peerId, pc);
    }

    // Track ended (user clicked browser "Stop sharing" button)
    this.screenStream.getVideoTracks()[0].onended = () => {
      this.stopScreenShare();
    };

    return true;
  }

  async stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach(t => t.stop());

    // Remove screen tracks from all peer connections
    for (const [peerId, { pc }] of this.peers) {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (sender.track && this.screenStream.getTracks().includes(sender.track)) {
          // track already stopped, just remove sender
        }
        // Remove senders that belong to screen stream
        if (sender.track && !this.localStream.getTracks().includes(sender.track)) {
          try { pc.removeTrack(sender); } catch (e) { /* ignore */ }
        }
      }
      await this._createAndSendOffer(peerId, pc);
    }

    this.screenStream = null;
    this.isSharing = false;
    this.socket.emit('screen-stop');
  }

  /* ========== Peer management ========== */

  /**
   * Create a new peer connection and send an offer (we are the initiator).
   */
  async connectToPeer(peerId) {
    const pc = this._createPeerConnection(peerId);
    this.peers.set(peerId, { pc, audioEl: null });

    // Add local audio tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // If we are screen-sharing, add those tracks too
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(track => {
        pc.addTrack(track, this.screenStream);
      });
    }

    await this._createAndSendOffer(peerId, pc);
  }

  /**
   * Remove a peer connection.
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.pc.close();
      if (peer.audioEl) {
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
      }
      this.peers.delete(peerId);
    }
  }

  /**
   * Cleanly shut down all connections.
   */
  destroy() {
    for (const [id] of this.peers) {
      this.removePeer(id);
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
    }
  }

  /* ========== Internal helpers ========== */

  _createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc._makingOffer = false;
    pc._pendingOffer = false;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;

      // Determine if this is a video track (screen share) or audio only
      if (e.track.kind === 'video') {
        if (this.onRemoteScreen) {
          this.onRemoteScreen(stream, peerId);
        }
        e.track.onended = () => {
          if (this.onScreenStopped) this.onScreenStopped(peerId);
        };
      } else if (e.track.kind === 'audio') {
        // Check if we already have audio for this peer
        const peerData = this.peers.get(peerId);
        if (peerData && !peerData.audioEl) {
          const audio = document.createElement('audio');
          audio.srcObject = stream;
          audio.autoplay = true;
          document.getElementById('audio-container').appendChild(audio);
          peerData.audioEl = audio;
        } else if (peerData && peerData.audioEl) {
          // Update existing audio element
          peerData.audioEl.srcObject = stream;
        }
      }
    };

    return pc;
  }

  async _createAndSendOffer(peerId, pc) {
    if (pc.signalingState !== 'stable') {
      pc._pendingOffer = true;
      return;
    }
    if (pc._makingOffer) {
      pc._pendingOffer = true;
      return;
    }

    try {
      pc._makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('offer', { to: peerId, offer: pc.localDescription });
    } catch (err) {
      console.error('Error creating offer:', err);
    } finally {
      pc._makingOffer = false;
      if (pc._pendingOffer && pc.signalingState === 'stable') {
        pc._pendingOffer = false;
        await this._createAndSendOffer(peerId, pc);
      }
    }
  }

  /**
   * Boost max bitrate on all video senders of a peer connection.
   * Target: 8 Mbps for crisp screen sharing.
   */
  async _setVideoBitrate(pc) {
    const MAX_BITRATE = 8_000_000; // 8 Mbps
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === 'video') {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = MAX_BITRATE;
          params.encodings[0].maxFramerate = 60;
          // Prefer no degradation on resolution (degrade framerate instead)
          if ('degradationPreference' in params) {
            params.degradationPreference = 'maintain-resolution';
          }
          await sender.setParameters(params);
        } catch (e) {
          console.warn('Could not set video bitrate:', e);
        }
      }
    }
  }

  _setupSignaling() {
    // Receive offer from a remote peer
    this.socket.on('offer', async ({ from, offer }) => {
      let peerData = this.peers.get(from);
      let pc;

      if (!peerData) {
        pc = this._createPeerConnection(from);
        this.peers.set(from, { pc, audioEl: null });

        // Add our local tracks
        if (this.localStream) {
          this.localStream.getTracks().forEach(track => {
            pc.addTrack(track, this.localStream);
          });
        }
        if (this.screenStream) {
          this.screenStream.getTracks().forEach(track => {
            pc.addTrack(track, this.screenStream);
          });
        }
      } else {
        pc = peerData.pc;
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('answer', { to: from, answer: pc.localDescription });
      } catch (err) {
        console.error('Error handling offer:', err);
      }
    });

    // Receive answer
    this.socket.on('answer', async ({ from, answer }) => {
      const peerData = this.peers.get(from);
      if (peerData) {
        try {
          await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
          if (peerData.pc._pendingOffer && peerData.pc.signalingState === 'stable') {
            peerData.pc._pendingOffer = false;
            await this._createAndSendOffer(from, peerData.pc);
          }
        } catch (err) {
          console.error('Error setting remote description:', err);
        }
      }
    });

    // Receive ICE candidate
    this.socket.on('ice-candidate', async ({ from, candidate }) => {
      const peerData = this.peers.get(from);
      if (peerData) {
        try {
          await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding ICE candidate:', err);
        }
      }
    });
  }
}
