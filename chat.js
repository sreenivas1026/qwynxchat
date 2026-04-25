        // WebRTC Configuration
        const rtcConfiguration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { 
                    urls: 'turn:openrelay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        };

        // Global Variables
        let peer = null;
        let conn = null;
        let localStream = null;
        let currentCall = null;
        let username = '';
        let peerUsername = '';
        let roomCode = '';
        let isCreator = false;
        let typingTimeout = null;
        let callTimer = null;
        let callStartTime = null;
        let isMuted = false;
        let isVideoOff = false;
        let isCallActive = false;
        let isIncomingCall = false;
        let replyTo = null;
        let mediaRecorder = null;
        let audioChunks = [];
        let recordingStartTime = null;
        let recordingTimer = null;
        let audioStreams = [];
        let chatSoundsMuted = false;

        // Message selection state for multi-delete
        let isSelectionMode = false;
        const selectedMsgIds = new Set();

        // Session persistence
        const SESSION_KEY = 'qwnyx_chat_session';
        let isRestoringSession = false; // Flag to prevent UI updates during session restore
        let sessionRestored = false; // Flag to track if session was restored
        let reconnectionInterval = null; // Retry interval for reconnection

        function saveSession() {
            const session = {
                username,
                roomCode,
                isCreator,
                peerUsername,
                timestamp: Date.now()
            };
            localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        }

        function loadSession() {
            const saved = localStorage.getItem(SESSION_KEY);
            if (!saved) {
                return null;
            }
            try {
                const session = JSON.parse(saved);
                // Session persists indefinitely until user leaves
                return session;
            } catch (e) {
                clearSession();
                return null;
            }
        }

        function clearSession() {
            localStorage.removeItem(SESSION_KEY);
            localStorage.removeItem(SESSION_KEY + '_messages');
        }

        // Save messages to localStorage
        function saveMessages(messages) {
            localStorage.setItem(SESSION_KEY + '_messages', JSON.stringify(messages));
        }

        // Load messages from localStorage
        function loadMessages() {
            const saved = localStorage.getItem(SESSION_KEY + '_messages');
            if (!saved) return [];
            try {
                return JSON.parse(saved);
            } catch (e) {
                return [];
            }
        }

        // Generate 8-digit room code
        function generateRoomCode() {
            const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
            let code = '';
            for (let i = 0; i < 8; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return code;
        }

        // Hash 8-digit code to create deterministic PeerID (32 chars)
        async function codeToPeerId(code) {
            const encoder = new TextEncoder();
            const data = encoder.encode(code.toUpperCase().trim());
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return 'peer-' + hashHex.substring(0, 28); // peer- + 28 chars = 32 total
        }

        // Tab switching
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            
            if (tab === 'create') {
                document.querySelectorAll('.tab')[0].classList.add('active');
                document.getElementById('createPanel').classList.add('active');
            } else {
                document.querySelectorAll('.tab')[1].classList.add('active');
                document.getElementById('joinPanel').classList.add('active');
            }
        }

        function deleteMessage(msgId, scope = 'me') {
            if (!msgId) return;

            const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
            if (wrapper) wrapper.remove();

            if (scope === 'everyone' && conn && conn.open) {
                conn.send({ type: 'delete', msgId });
            }
        }

        // Create Room
        async function createRoom() {
            // Only get from input if username not already set (e.g., from session restore)
            if (!username) {
                username = document.getElementById('createUsername').value.trim();
            }
            if (!username) {
                showNotification('Please enter your name', 'error');
                return;
            }

            isCreator = true;

            // Generate 8-digit room code only if not already set (e.g., from session restore)
            if (!roomCode) {
                roomCode = generateRoomCode();
            }
            document.getElementById('roomCode').textContent = roomCode;
            document.getElementById('codeDisplay').classList.add('show');

            // Convert 8-digit code to deterministic PeerID
            const peerId = await codeToPeerId(roomCode);

            // If peer already exists (from failed reconnect), destroy it first
            if (peer) {
                try {
                    peer.destroy();
                } catch (e) {}
                peer = null;
            }

            // Initialize PeerJS with deterministic ID from hash
            peer = new Peer(peerId, {
                config: rtcConfiguration
            });

            peer.on('open', (id) => {
                showNotification('Room created! Share code: ' + roomCode, 'success');
                saveSession();

                // Join Socket.io room for presence tracking
                if (socket) {
                    socket.emit('join', { roomCode, username });
                }
            });

            peer.on('connection', (connection) => {
                conn = connection;
                setupConnection();
                saveSession();
            });

            // Handle incoming media calls
            peer.on('call', (call) => {
                // Store the call for later (accept/decline)
                pendingCall = call;
                const isVideo = call.metadata?.isVideo || false;
                
                // Show incoming call dialog
                showIncomingCall(call, peerUsername);
            });

            peer.on('error', (err) => {
                if (err.type === 'unavailable-id') {
                    document.getElementById('peerStatus').textContent = 'new code...';
                    // Destroy the failed peer
                    if (peer) {
                        try {
                            peer.destroy();
                        } catch (e) {}
                        peer = null;
                    }
                    // Generate new room code
                    roomCode = generateRoomCode();
                    document.getElementById('roomCode').textContent = roomCode;
                    document.getElementById('codeDisplay').classList.add('show');
                    showNotification('New room code: ' + roomCode + '. Share with your friend.', 'success');
                    // Try creating with new code after 1 second
                    setTimeout(() => {
                        if (isRestoringSession || document.getElementById('chatScreen').classList.contains('active')) {
                            createRoom();
                        }
                    }, 1000);
                } else {
                    showNotification('Connection error. Please try again.', 'error');
                }
            });
        }

        // Join Room
        async function joinRoom() {
            // Only get from input if username/roomCode not already set (e.g., from session restore)
            if (!username) {
                username = document.getElementById('joinUsername').value.trim();
            }
            const inputCode = roomCode || document.getElementById('roomCodeInput').value.trim().toUpperCase();

            if (!username) {
                showNotification('Please enter your name', 'error');
                return;
            }

            if (!inputCode || inputCode.length < 8) {
                showNotification('Please enter the 8-digit room code', 'error');
                return;
            }

            isCreator = false;
            roomCode = inputCode;

            // Compute the SAME PeerID that creator has (deterministic from code)
            const creatorPeerId = await codeToPeerId(roomCode);

            document.getElementById('peerName').textContent = 'Connecting...';
            document.getElementById('joinRoomBtn').disabled = true;

            // Create our own peer with random ID
            peer = new Peer({
                config: rtcConfiguration
            });

            let connectionTimeout = setTimeout(() => {
                showNotification('Room not found or creator offline. Check the code.', 'error');
                document.getElementById('joinRoomBtn').disabled = false;
            }, 15000);

            peer.on('open', (myId) => {
                // Connect to creator using the hashed PeerID
                conn = peer.connect(creatorPeerId, {
                    reliable: true,
                    metadata: { username: username }
                });
                
                conn.on('open', () => {
                    clearTimeout(connectionTimeout);
                    setupConnection();

                    // Join Socket.io room for presence tracking
                    if (socket) {
                        socket.emit('join', { roomCode, username });
                    }
                });
                
                conn.on('error', (err) => {
                    clearTimeout(connectionTimeout);
                    showNotification('Connection failed. Creator may have left.', 'error');
                    document.getElementById('joinRoomBtn').disabled = false;
                });
            });

            peer.on('error', (err) => {
                clearTimeout(connectionTimeout);
                showNotification('Connection error: ' + err.type, 'error');
                document.getElementById('joinRoomBtn').disabled = false;
            });

            // Handle incoming media calls (for joiner)
            peer.on('call', (call) => {
                // Store the call for later (accept/decline)
                pendingCall = call;
                const isVideo = call.metadata?.isVideo || false;
                
                // Show incoming call dialog
                showIncomingCall(call, peerUsername);
            });
        }

        // Setup Connection
        function setupConnection() {
            if (!conn) return;

            // Prevent duplicate handler attachment when called multiple times
            if (conn.__qwynxHandlersAttached) {
                return;
            }
            conn.__qwynxHandlersAttached = true;

            // Handler for when connection is open
            const onConnectionOpen = () => {
                updateOnlineStatus(true);
                // Send username
                conn.send({
                    type: 'username',
                    username: username
                });
                // Save session
                saveSession();
                // Show chat screen
                showChatScreen();
            };

            // If already open (joiner case), show chat immediately
            if (conn.open) {
                onConnectionOpen();
            } else {
                // Otherwise wait for open event (creator case)
                conn.on('open', onConnectionOpen);
            }

            conn.on('data', handleIncomingData);

            conn.on('close', () => {
                // Don't close chat screen on connection lost - user can manually reconnect
                updateOnlineStatus(false);
                document.getElementById('peerStatus').textContent = 'disconnected';
                showNotification('Connection lost. Reconnecting...', 'warning');

                // If joiner and connection lost, destroy peer to free up creator's PeerID on server
                if (!isCreator && peer) {
                    try {
                        peer.destroy();
                    } catch (e) {}
                    peer = null;
                }

                // If joiner and connection lost, try to reconnect
                if (!isCreator && !isRestoringSession) {
                    setTimeout(() => {
                        if (document.getElementById('chatScreen').classList.contains('active')) {
                            joinRoom().catch(() => {
                                // If reconnection fails, clear session so user can enter new room code
                                clearSession();
                                showNotification('Reconnection failed. Creator may have new room code.', 'warning');
                                document.getElementById('chatScreen').classList.remove('active');
                                document.getElementById('setupScreen').classList.add('active');
                            });
                        }
                    }, 3000);
                }
            });

            conn.on('error', (err) => {
                // Don't close chat screen on connection error - user can manually reconnect
                updateOnlineStatus(false);
                document.getElementById('peerStatus').textContent = 'error';
                showNotification('Connection error. Reconnecting...', 'error');
            });
        }

        // Handle Incoming Data
        function handleIncomingData(data) {
            switch(data.type) {
                case 'username':
                    peerUsername = data.username;
                    updatePeerDisplay();
                    break;
                case 'message':
                    displayMessage(data.message, 'received', data.msgId || null, data.replyTo || null);
                    playMessageSound(); // Play notification sound
                    hideTypingIndicator();
                    break;
                case 'typing':
                    showTypingIndicator();
                    break;
                case 'stop_typing':
                    hideTypingIndicator();
                    break;
                case 'delete':
                    const delWrapper = document.querySelector(`[data-msg-id="${data.msgId}"]`);
                    if (delWrapper) delWrapper.remove();
                    break;
                case 'audio':
                    displayAudioMessage('received', data.audio, data.duration);
                    hideTypingIndicator();
                    break;
                case 'call-ended':
                    // Other person ended the call
                    if (isCallActive || isIncomingCall || currentCall) {
                        isCallActive = false;
                        isIncomingCall = false;
                        endCall();
                        showNotification('Call ended by other person', 'info');
                    }
                    break;
                case 'call-declined':
                    // Other person declined our call
                    if (isCallActive) {
                        isCallActive = false;
                        endCall();
                        showNotification('Call declined', 'warning');
                    }
                    break;
                case 'call-request':
                    // Other person is calling us - this is handled by the peer.on('call') event
                    // But we can use this to show a visual indicator if needed
                    break;
                case 'mute-status':
                    // Update remote mute indicator
                    updateRemoteMuteIndicator(data.isMuted);
                    break;
                case 'seen':
                    // Mark message as seen
                    const seenEl = document.getElementById('seen-' + data.msgId);
                    if (seenEl) {
                        seenEl.textContent = '✓✓';
                        seenEl.classList.add('seen');
                    }
                    break;
                case 'status':
                    // Update peer status (online/away/offline)
                    updatePeerStatus(data.status);
                    break;
                case 'leave':
                    // Other person left the chat
                    showNotification(data.message || 'Other person has left the chat. Please recreate room.', 'warning');
                    document.getElementById('peerStatus').textContent = 'left';
                    document.getElementById('onlineIndicator').style.display = 'none';
                    // Clear connection
                    if (conn) {
                        conn.close();
                        conn = null;
                    }
                    // Clear reconnection interval
                    if (reconnectionInterval) {
                        clearInterval(reconnectionInterval);
                        reconnectionInterval = null;
                    }
                    break;
                case 'secret-mode':
                    // Sync secret mode from other peer
                    if (data.enabled !== isEncryptionEnabled) {
                        isEncryptionEnabled = data.enabled;
                        // Update badge
                        const badge = document.getElementById('encryptBadge');
                        if (badge) {
                            badge.textContent = isEncryptionEnabled ? 'ON' : 'OFF';
                            badge.classList.toggle('active', isEncryptionEnabled);
                        }
                        // Apply encryption/decryption to all messages
                        document.querySelectorAll('.message-wrapper .message-bubble').forEach(bubble => {
                            const msgId = bubble.id.replace('bubble-', '');
                            const originalText = encryptedMessages.get(msgId);
                            
                            if (isEncryptionEnabled) {
                                if (!originalText) {
                                    const currentText = bubble.textContent;
                                    encryptedMessages.set(msgId, currentText);
                                    bubble.textContent = encryptText(currentText);
                                }
                                bubble.classList.add('encrypted');
                            } else {
                                if (originalText) {
                                    bubble.textContent = originalText;
                                    encryptedMessages.delete(msgId);
                                }
                                bubble.classList.remove('encrypted');
                            }
                        });
                        showNotification(isEncryptionEnabled ? 'Secret mode enabled by other peer' : 'Secret mode disabled by other peer', 'info');
                    }
                    break;
            }
        }

        // Update remote mute indicator in call UI
        function updateRemoteMuteIndicator(isRemoteMuted) {
            const remoteMuteIndicator = document.getElementById('remoteMuteIndicator');
            const callProfileStatus = document.getElementById('callProfileStatus');
            
            if (isRemoteMuted) {
                remoteMuteIndicator.style.display = 'flex';
                callProfileStatus.textContent = 'Muted';
                callProfileStatus.style.color = '#ff9500';
            } else {
                remoteMuteIndicator.style.display = 'none';
                if (isCallActive) {
                    callProfileStatus.textContent = 'On call';
                    callProfileStatus.style.color = 'rgba(255,255,255,0.7)';
                }
            }
        }

        // Show Chat Screen
        function showChatScreen() {
            document.getElementById('setupScreen').classList.remove('active');
            document.getElementById('chatScreen').classList.add('active');
            document.getElementById('onlineIndicator').style.display = 'block';
            loadChatTheme();
            setupVanishModeTrigger();
        }

        // Update Peer Display
        function updatePeerDisplay() {
            document.getElementById('peerName').textContent = peerUsername;
            document.getElementById('avatarInitial').textContent = peerUsername.charAt(0).toUpperCase();
        }

        // Send Message
        function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();

            if (!message || !conn || !conn.open) return;

            const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            conn.send({
                type: 'message',
                message: message,
                msgId: msgId,
                replyTo: replyTo
            });

            // Notify server for push notification to offline users
            if (socket && roomCode) {
                socket.emit('message-sent', { roomCode, username, message });
            }

            displayMessage(message, 'sent', msgId, replyTo);
            input.value = '';
            input.style.height = 'auto';
            replyTo = null;
            updateReplyStrip();
        }

        // Message encryption state
        let isEncryptionEnabled = false;
        const encryptedMessages = new Map();

        // Message seen receipts
        const seenMessages = new Set(); // Track which messages have been seen

        // Away status tracking
        let isAway = false;

        // Online/offline status
        let isOnline = true;

        // Vanish mode - messages disappear
        let isVanishMode = false;

        // Socket.io for online status
        let socket = null;
        const SOCKET_SERVER_URL = 'https://qwynxchat.vercel.app';

        // Push notification subscription
        let pushSubscription = null;
        const VAPID_PUBLIC_KEY = 'BGnEechzDRM7-vVgkBzMDJPOAvUPD_QnnlSMFo7r6RfHTXX8OtSMp4LKw4WIt2cjF-dwdGt6lamhZ-mf9wapUGU';

        // Register Service Worker and subscribe to push notifications
        async function registerPushNotifications() {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
                return;
            }

            try {
                // Register service worker
                const registration = await navigator.serviceWorker.register('/sw.js');
                await registration.update();

                // Request permission
                const permission = await Notification.requestPermission();
                if (permission !== 'granted') {
                    showNotification('Notification permission denied', 'warning');
                    return;
                }

                // Subscribe to push
                const subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                });

                pushSubscription = subscription;

                // Send subscription to server
                if (socket && roomCode) {
                    socket.emit('register-push', { roomCode, subscription });
                }

                showNotification('Push notifications enabled', 'success');
            } catch (error) {
                showNotification('Push notification error', 'error');
            }
        }

        // Convert VAPID key to Uint8Array
        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        }

        // Connect to Socket.io for presence tracking
        function connectSocket() {
            if (socket) return;

            socket = io(SOCKET_SERVER_URL);

            socket.on('connect', () => {
                if (username && roomCode) {
                    socket.emit('join', { roomCode, username });

                    // Register push subscription if available
                    if (pushSubscription) {
                        socket.emit('register-push', { roomCode, subscription: pushSubscription });
                    }
                }
            });

            socket.on('user-online', (data) => {
                showNotification(`${data.username} is online`, 'success');
            });

            socket.on('user-offline', (data) => {
                showNotification(`${data.username} is offline`, 'warning');
            });
        }

        // Check if room has online users
        function checkRoomOnline(roomCode, callback) {
            if (!socket) {
                callback({ online: false, count: 0 });
                return;
            }
            socket.emit('check-online', { roomCode }, callback);
        }

        // Display Message
        function displayMessage(message, type, msgId = null, replyMeta = null, skipSave = false) {
            const messagesArea = document.getElementById('messagesArea');
            const wrapper = document.createElement('div');
            wrapper.className = `message-wrapper ${type}`;
            const id = msgId || 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            wrapper.dataset.msgId = id;
            
            const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            
            // If encryption enabled for sent messages, encrypt them
            let displayText = message;
            let isEncrypted = false;
            if (type === 'sent' && isEncryptionEnabled) {
                displayText = encryptText(message);
                isEncrypted = true;
                encryptedMessages.set(id, message);
            }

            let replyHtml = '';
            if (replyMeta && replyMeta.msgId) {
                const repliedBubble = document.getElementById('bubble-' + replyMeta.msgId);
                const repliedText = (replyMeta.preview || repliedBubble?.textContent || '').trim();
                const replyLabel = replyMeta.type === 'sent' ? 'You' : (peerUsername || 'User');
                replyHtml = `
                    <div class="reply-quote ${type}">
                        <div class="reply-quote-bar"></div>
                        <div class="reply-quote-body">
                            <div class="reply-quote-title">${escapeHtml(replyLabel)}</div>
                            <div class="reply-quote-text">${escapeHtml(repliedText).slice(0, 120)}</div>
                        </div>
                    </div>
                `;
            }
            
            wrapper.innerHTML = `
                <div class="message">
                    <div class="message-bubble ${isEncrypted ? 'encrypted' : ''}" id="bubble-${id}" data-msg-id="${id}">${replyHtml}<div class="message-text">${escapeHtml(displayText)}</div></div>
                    <div class="message-time">
                        ${time}
                        ${type === 'sent' ? `<span class="seen-status" id="seen-${id}"></span>` : ''}
                    </div>
                </div>
            `;

            messagesArea.appendChild(wrapper);
            messagesArea.scrollTop = messagesArea.scrollHeight;

            // Attach gesture handlers (swipe-to-reply + selection)
            attachMessageGestures(wrapper, id, type);

            // Send seen receipt for received messages
            if (type === 'received' && conn && conn.open) {
                conn.send({ type: 'seen', msgId: id });
            }

            // Save message to localStorage for persistence (skip if restoring)
            if (!skipSave) {
                const savedMessages = loadMessages();
                savedMessages.push({ message, type, msgId: id, replyMeta, time, isEncrypted });
                saveMessages(savedMessages);
            }

            // Apply vanish mode if active
            if (isVanishMode) {
                wrapper.classList.add('vanished');
            }
        }

        // Toggle vanish mode
        function toggleVanishMode() {
            isVanishMode = !isVanishMode;

            if (isVanishMode) {
                // Make all existing messages vanish immediately
                document.querySelectorAll('.message-wrapper').forEach(wrapper => {
                    wrapper.classList.add('vanished');
                });
                showNotification('Vanish mode ON', 'info');
            } else {
                // Remove vanish effect from all messages
                document.querySelectorAll('.message-wrapper').forEach(wrapper => {
                    wrapper.classList.remove('vanished');
                });
                showNotification('Vanish mode OFF', 'info');
            }
        }

        // Triple-tap detection for vanish mode
        let tapCount = 0;
        let tapTimeout = null;

        function setupVanishModeTrigger() {
            const chatScreen = document.getElementById('chatScreen');
            if (!chatScreen) return;

            chatScreen.addEventListener('click', (e) => {
                // Ignore clicks on interactive elements
                if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea')) {
                    return;
                }

                tapCount++;

                if (tapCount === 3) {
                    toggleVanishMode();
                    tapCount = 0;
                    if (tapTimeout) {
                        clearTimeout(tapTimeout);
                        tapTimeout = null;
                    }
                } else {
                    // Reset tap count after 1 second if 3 taps not reached
                    if (tapTimeout) {
                        clearTimeout(tapTimeout);
                    }
                    tapTimeout = setTimeout(() => {
                        tapCount = 0;
                    }, 1000);
                }
            });
        }

        function ensureReplyUI() {
            const inputArea = document.querySelector('.input-area');
            if (!inputArea) return;
            if (document.getElementById('replyStrip')) return;

            const replyStrip = document.createElement('div');
            replyStrip.id = 'replyStrip';
            replyStrip.className = 'reply-strip';
            replyStrip.style.display = 'none';
            replyStrip.innerHTML = `
                <div class="reply-strip-content">
                    <div class="reply-strip-title">Replying</div>
                    <div class="reply-strip-text" id="replyStripText"></div>
                </div>
                <button class="reply-strip-close" id="replyStripClose" type="button">&times;</button>
            `;

            inputArea.insertBefore(replyStrip, inputArea.firstChild);

            document.getElementById('replyStripClose').addEventListener('click', () => {
                replyTo = null;
                updateReplyStrip();
            });
        }

        function updateReplyStrip() {
            const strip = document.getElementById('replyStrip');
            const textEl = document.getElementById('replyStripText');
            if (!strip || !textEl) return;
            if (!replyTo) {
                strip.style.display = 'none';
                return;
            }
            strip.style.display = 'flex';
            textEl.textContent = replyTo.preview || '';
        }

        // Selection toolbar for multi-delete
        function ensureSelectionToolbar() {
            const chatScreen = document.getElementById('chatScreen');
            if (!chatScreen) return;
            if (document.getElementById('selectionToolbar')) return;

            const bar = document.createElement('div');
            bar.id = 'selectionToolbar';
            bar.className = 'selection-toolbar';
            bar.style.display = 'none';
            bar.innerHTML = `
                <button class="sel-btn" id="selDeleteMe" type="button"><i class="fas fa-trash"></i> For Me</button>
                <div class="sel-count" id="selCount">0</div>
                <button class="sel-btn danger" id="selDeleteAll" type="button"><i class="fas fa-trash-alt"></i> For All</button>
                <button class="sel-btn close" id="selClose" type="button"><i class="fas fa-times"></i></button>
            `;

            chatScreen.appendChild(bar);

            document.getElementById('selClose').addEventListener('click', exitSelectionMode);
            document.getElementById('selDeleteMe').addEventListener('click', () => deleteSelectedMessages('me'));
            document.getElementById('selDeleteAll').addEventListener('click', () => deleteSelectedMessages('everyone'));
        }

        function setSelectionMode(enabled) {
            isSelectionMode = enabled;
            const bar = document.getElementById('selectionToolbar');
            if (bar) bar.style.display = enabled ? 'flex' : 'none';
            if (!enabled) {
                selectedMsgIds.clear();
                document.querySelectorAll('.message-wrapper.selected').forEach(el => el.classList.remove('selected'));
            }
            updateSelectionToolbar();
        }

        function exitSelectionMode() {
            setSelectionMode(false);
        }

        function updateSelectionToolbar() {
            const countEl = document.getElementById('selCount');
            if (countEl) countEl.textContent = `${selectedMsgIds.size}`;
        }

        function toggleMessageSelected(wrapperEl) {
            const id = wrapperEl?.dataset?.msgId;
            if (!id) return;
            if (selectedMsgIds.has(id)) {
                selectedMsgIds.delete(id);
                wrapperEl.classList.remove('selected');
            } else {
                selectedMsgIds.add(id);
                wrapperEl.classList.add('selected');
            }
            updateSelectionToolbar();
            if (selectedMsgIds.size === 0) {
                exitSelectionMode();
            }
        }

        function deleteSelectedMessages(scope) {
            const ids = Array.from(selectedMsgIds);
            ids.forEach((id) => deleteMessage(id, scope));
            setSelectionMode(false);
        }

        function attachMessageGestures(wrapper, msgId, type) {
            ensureReplyUI();
            ensureSelectionToolbar();

            let startX = 0;
            let startY = 0;
            let active = false;
            let swiped = false;
            let longPressTimer;

            const bubble = wrapper.querySelector('.message-bubble');

            // Long press: enter selection mode and select this message
            let longPressTriggered = false;
            wrapper.addEventListener('touchstart', (e) => {
                if (!e.touches || e.touches.length !== 1) return;
                const t = e.touches[0];
                startX = t.clientX;
                startY = t.clientY;
                active = true;
                swiped = false;
                longPressTriggered = false;

                clearTimeout(longPressTimer);
                longPressTimer = setTimeout(() => {
                    if (!active || swiped) return;
                    longPressTriggered = true;
                    setSelectionMode(true);
                    toggleMessageSelected(wrapper);
                }, 500);
            }, { passive: true });

            wrapper.addEventListener('touchmove', (e) => {
                if (!active || !e.touches || e.touches.length !== 1) return;
                const t = e.touches[0];
                const dx = t.clientX - startX;
                const dy = t.clientY - startY;

                // Cancel long press if user is scrolling
                if (Math.abs(dy) > 10) {
                    clearTimeout(longPressTimer);
                }

                // Horizontal swipe detection
                if (Math.abs(dx) > 25 && Math.abs(dx) > Math.abs(dy)) {
                    swiped = true;
                    clearTimeout(longPressTimer);
                    if (bubble) {
                        bubble.style.transform = `translateX(${Math.min(60, Math.max(0, dx))}px)`;
                        bubble.style.transition = 'none';
                    }
                }
            }, { passive: true });

            wrapper.addEventListener('touchend', (e) => {
                clearTimeout(longPressTimer);
                if (!active) return;
                active = false;

                if (bubble) {
                    bubble.style.transition = 'transform 180ms ease';
                    bubble.style.transform = 'translateX(0px)';
                }

                // Skip if long-press just triggered selection (don't toggle again)
                if (longPressTriggered) {
                    return;
                }

                if (isSelectionMode) {
                    // In selection mode, tap toggles selection
                    toggleMessageSelected(wrapper);
                    return;
                }

                if (swiped && bubble) {
                    // treat as swipe-to-reply only if swipe is right
                    const touch = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : null;
                    if (touch) {
                        const dx = touch.clientX - startX;
                        if (dx > 45) {
                            const bubbleEl = document.getElementById('bubble-' + msgId);
                            const preview = (bubbleEl?.textContent || '').trim().slice(0, 80);
                            replyTo = { msgId, type, preview };
                            updateReplyStrip();
                            document.getElementById('messageInput')?.focus?.();
                        }
                    }
                }
            });

            // Desktop: Ctrl+click to toggle selection
            wrapper.addEventListener('click', (e) => {
                if (!isSelectionMode) return;
                e.preventDefault();
                toggleMessageSelected(wrapper);
            });
        }

        // Display Call Log
        function displayCallLog(text, type = 'info') {
            const messagesArea = document.getElementById('messagesArea');
            const wrapper = document.createElement('div');
            wrapper.className = 'call-log-wrapper';
            
            const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            
            let icon = 'fa-phone';
            let colorClass = '';
            if (type === 'missed') {
                icon = 'fa-phone-slash';
                colorClass = 'missed';
            } else if (type === 'incoming') {
                icon = 'fa-phone-arrow-down';
            } else if (type === 'outgoing') {
                icon = 'fa-phone-arrow-up';
            }
            
            wrapper.innerHTML = `
                <div class="call-log ${colorClass}">
                    <i class="fas ${icon}"></i>
                    <span>${text}</span>
                    <span class="call-log-time">${time}</span>
                </div>
            `;
            
            messagesArea.appendChild(wrapper);
            messagesArea.scrollTop = messagesArea.scrollHeight;
        }

        // Simple encryption (Caesar cipher with random shift)
        function encryptText(text) {
            const shift = 3;
            return text.split('').map(c => {
                if (c.match(/[a-z]/i)) {
                    const code = c.charCodeAt(0);
                    const base = code < 97 ? 65 : 97;
                    return String.fromCharCode(((code - base + shift) % 26) + base);
                }
                return c;
            }).join('');
        }

        function decryptText(text) {
            const shift = 3;
            return text.split('').map(c => {
                if (c.match(/[a-z]/i)) {
                    const code = c.charCodeAt(0);
                    const base = code < 97 ? 65 : 97;
                    return String.fromCharCode(((code - base - shift + 26) % 26) + base);
                }
                return c;
            }).join('');
        }

        // Toggle encryption mode (per-user: affects ALL messages on this screen only)
        function toggleEncryption() {
            isEncryptionEnabled = !isEncryptionEnabled;
            // Update menu badge
            const badge = document.getElementById('encryptBadge');
            if (badge) {
                badge.textContent = isEncryptionEnabled ? 'ON' : 'OFF';
                badge.classList.toggle('active', isEncryptionEnabled);
            }
            
            // Encrypt/Decrypt ALL messages (both sent and received) on THIS screen only
            document.querySelectorAll('.message-wrapper .message-bubble').forEach(bubble => {
                const msgId = bubble.id.replace('bubble-', '');
                const originalText = encryptedMessages.get(msgId);
                
                if (isEncryptionEnabled) {
                    // Encrypt - store original and show encrypted
                    if (!originalText) {
                        const currentText = bubble.textContent;
                        encryptedMessages.set(msgId, currentText);
                        bubble.textContent = encryptText(currentText);
                    }
                    bubble.classList.add('encrypted');
                } else {
                    // Decrypt - restore original
                    if (originalText) {
                        bubble.textContent = originalText;
                        encryptedMessages.delete(msgId);
                    }
                    bubble.classList.remove('encrypted');
                }
            });
            
            showNotification(isEncryptionEnabled ? 'Secret mode enabled - all messages encrypted' : 'Secret mode disabled', 'success');
        }

        // Toggle chat menu
        function toggleChatMenu() {
            const menu = document.getElementById('chatMenu');
            menu.classList.toggle('show');
            
            // Close menu when clicking outside
            if (menu.classList.contains('show')) {
                setTimeout(() => {
                    document.addEventListener('click', function closeMenu(e) {
                        if (!menu.contains(e.target) && !e.target.closest('.menu-btn')) {
                            menu.classList.remove('show');
                            document.removeEventListener('click', closeMenu);
                        }
                    });
                }, 10);
            }
        }

        // Go back to setup screen
        function goBackToSetup() {
            if (confirm('Leave this chat?')) {
                disconnectChat();
            }
        }

        // Disconnect chat
        function disconnectChat() {
            // Notify other person before disconnecting
            if (conn && conn.open) {
                conn.send({ type: 'leave', message: 'User has left the chat' });
            }

            // Clear reconnection interval
            if (reconnectionInterval) {
                clearInterval(reconnectionInterval);
                reconnectionInterval = null;
            }

            if (conn) {
                conn.close();
                conn = null;
            }
            if (peer) {
                peer.destroy();
                peer = null;
            }
            // Clear messages
            document.getElementById('messagesArea').innerHTML = '';
            // Hide chat menu
            document.getElementById('chatMenu')?.classList.remove('show');
            // Go back to setup
            document.getElementById('chatScreen').classList.remove('active');
            document.getElementById('setupScreen').classList.add('active');
            // Clear session (user explicitly left)
            clearSession();
            showNotification('Chat ended', 'info');
        }

        // Clear all chat messages
        function clearChat() {
            if (confirm('Clear all messages? This cannot be undone.')) {
                document.getElementById('messagesArea').innerHTML = '';
                showNotification('Chat cleared', 'success');
            }
        }

        // Export chat
        function exportChat() {
            const messages = [];
            document.querySelectorAll('.message-wrapper').forEach(wrapper => {
                const type = wrapper.classList.contains('sent') ? 'sent' : 'received';
                const bubble = wrapper.querySelector('.message-bubble');
                const time = wrapper.querySelector('.message-time');
                messages.push({
                    type,
                    text: bubble.textContent,
                    time: time.textContent
                });
            });
            
            const data = {
                peer: peerUsername,
                exported: new Date().toISOString(),
                messages
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chat_${peerUsername || 'export'}_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showNotification('Chat exported', 'success');
        }

        // Audio recording
        async function toggleAudioRecording() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                stopAudioRecording();
                return;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                audioStreams.push(stream);
                
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) audioChunks.push(e.data);
                };
                
                mediaRecorder.onstop = () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    sendAudioMessage(audioBlob);
                    audioStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
                    audioStreams = [];
                };
                
                mediaRecorder.start();
                recordingStartTime = Date.now();
                
                // Show recording UI
                document.getElementById('messageInput').style.display = 'none';
                document.querySelector('.send-button').style.display = 'none';
                document.getElementById('audioRecording').style.display = 'flex';
                document.getElementById('audioBtn').classList.add('recording');
                
                // Start timer
                recordingTimer = setInterval(updateRecordingTime, 1000);
                updateRecordingTime();
                
            } catch (err) {
                showNotification('Microphone access denied', 'error');
            }
        }

        function stopAudioRecording() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
            
            // Hide recording UI
            document.getElementById('messageInput').style.display = 'block';
            document.querySelector('.send-button').style.display = 'flex';
            document.getElementById('audioRecording').style.display = 'none';
            document.getElementById('audioBtn').classList.remove('recording');
            
            clearInterval(recordingTimer);
            recordingTimer = null;
        }

        function updateRecordingTime() {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const secs = String(elapsed % 60).padStart(2, '0');
            document.getElementById('recordingTime').textContent = `${mins}:${secs}`;
        }

        function sendAudioMessage(audioBlob) {
            if (!conn || !conn.open) return;
            
            const reader = new FileReader();
            reader.onload = () => {
                const base64Audio = reader.result.split(',')[1];
                conn.send({
                    type: 'audio',
                    audio: base64Audio,
                    duration: document.getElementById('recordingTime').textContent
                });
                displayAudioMessage('sent', base64Audio, document.getElementById('recordingTime').textContent);
            };
            reader.readAsDataURL(audioBlob);
        }

        function displayAudioMessage(type, base64Audio, duration) {
            const messagesArea = document.getElementById('messagesArea');
            const wrapper = document.createElement('div');
            wrapper.className = `message-wrapper ${type}`;
            const id = 'audio-' + Date.now();
            wrapper.dataset.msgId = id;
            
            const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            
            wrapper.innerHTML = `
                <div class="message">
                    <div class="message-bubble audio-bubble">
                        <audio controls src="data:audio/webm;base64,${base64Audio}"></audio>
                        <span class="audio-duration">${duration}</span>
                    </div>
                    <div class="message-time">${time}</div>
                </div>
            `;
            
            messagesArea.appendChild(wrapper);
            messagesArea.scrollTop = messagesArea.scrollHeight;
            
            // Attach gesture handlers (swipe-to-reply + selection)
            attachMessageGestures(wrapper, id, type);
        }

        // Show message context menu
        function showMessageMenu(event, msgId, type) {
            event.preventDefault();
            
            const existingMenu = document.querySelector('.message-menu');
            if (existingMenu) existingMenu.remove();
            
            const menu = document.createElement('div');
            menu.className = 'message-menu';
            menu.style.cssText = `
                position: fixed;
                background: var(--bg-primary);
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 8px 0;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                z-index: 10000;
                min-width: 160px;
            `;
            
            const bubble = document.getElementById('bubble-' + msgId);
            const isEncrypted = bubble.classList.contains('encrypted');
            
            let menuHTML = '';
            
            if (isEncrypted) {
                menuHTML += `<div class="menu-item" onclick="revealMessage('${msgId}')" style="padding: 10px 16px; cursor: pointer; font-size: 14px; hover: background: var(--hover);">
                    <i class="fas fa-eye" style="margin-right: 8px; width: 16px;"></i> Reveal Text
                </div>`;
            }
            
            // Only show menu if there's something to display
            if (!menuHTML) {
                return; // No menu needed for normal messages
            }
            
            menu.innerHTML = menuHTML;
            menu.style.left = event.clientX + 'px';
            menu.style.top = event.clientY + 'px';
            
            document.body.appendChild(menu);
            
            // Close menu on click outside
            setTimeout(() => {
                document.addEventListener('click', function closeMenu(e) {
                    if (!menu.contains(e.target)) {
                        menu.remove();
                        document.removeEventListener('click', closeMenu);
                    }
                });
            }, 10);
        }

        // Reveal encrypted message
        function revealMessage(msgId) {
            const bubble = document.getElementById('bubble-' + msgId);
            const originalText = encryptedMessages.get(msgId);
            if (originalText) {
                bubble.textContent = originalText;
                bubble.classList.remove('encrypted');
            }
            document.querySelector('.message-menu')?.remove();
        }

        // Delete message
        function deleteMessage(msgId, scope) {
            const wrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
            if (wrapper) {
                if (scope === 'everyone' && conn && conn.open) {
                    conn.send({ type: 'delete', msgId: msgId });
                }
                wrapper.remove();
            }
            document.querySelector('.message-menu')?.remove();
        }

        // Typing Indicators
        function handleTyping() {
            if (!conn || !conn.open) return;
            
            if (!typingTimeout) {
                conn.send({ type: 'typing' });
            }
            
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                conn.send({ type: 'stop_typing' });
                typingTimeout = null;
            }, 1000);
        }

        function showTypingIndicator() {
            document.getElementById('typingName').textContent = peerUsername || 'Someone';
            document.getElementById('typingBubble').classList.add('active');
        }

        function hideTypingIndicator() {
            document.getElementById('typingBubble').classList.remove('active');
        }

        // Theme toggle for chat screen
        function toggleChatTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('chat-theme', newTheme);
            showNotification(newTheme === 'dark' ? 'Dark mode enabled' : 'Light mode enabled', 'success');
        }

        // Load saved chat theme
        function loadChatTheme() {
            const savedTheme = localStorage.getItem('chat-theme') || 'light';
            document.documentElement.setAttribute('data-theme', savedTheme);
        }

        // Update online/offline status
        function updateOnlineStatus(isOnline) {
            const status = document.getElementById('peerStatus');

            if (isOnline) {
                status?.classList.remove('offline');
                status.textContent = 'online';
            } else {
                status?.classList.add('offline');
                status.textContent = 'offline';
            }
        }

        // Update peer status (online/away/offline)
        function updatePeerStatus(status) {
            const statusEl = document.getElementById('peerStatus');
            if (!statusEl) return;

            statusEl.classList.remove('online', 'offline', 'away');

            switch (status) {
                case 'online':
                    statusEl.classList.add('online');
                    statusEl.textContent = 'online';
                    break;
                case 'away':
                    statusEl.classList.add('away');
                    statusEl.textContent = 'away';
                    break;
                case 'offline':
                    statusEl.classList.add('offline');
                    statusEl.textContent = 'offline';
                    break;
            }
        }

        // Send status to peer
        function sendStatus(status) {
            if (conn && conn.open) {
                conn.send({ type: 'status', status: status });
            }
        }

        // Page visibility API - detect when user is away
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // User is away (tab hidden/minimized)
                isAway = true;
                sendStatus('away');
            } else {
                // User is back (tab visible)
                isAway = false;
                if (isOnline) {
                    sendStatus('online');
                }
            }
        });

        // Online/offline event listeners
        window.addEventListener('online', () => {
            isOnline = true;
            if (!isAway) {
                sendStatus('online');
            }
            showNotification('You are back online', 'success');
        });

        window.addEventListener('offline', () => {
            isOnline = false;
            sendStatus('offline');
            showNotification('You are offline', 'warning');
        });

        // Voice/Video Calls
        async function startVoiceCall() {
            await startCall(false);
        }

        async function startVideoCall() {
            await startCall(true);
        }

        async function startCall(isVideo) {
            if (!peer || !conn || !conn.open) {
                showNotification('No connection', 'error');
                return;
            }

            // Prevent duplicate calls
            if (isCallActive || isIncomingCall) {
                const callModalVisible = document.getElementById('callModal')?.classList?.contains('show');
                const incomingVisible = document.getElementById('incomingCallModal')?.classList?.contains('show');
                const hasActiveObjects = !!(currentCall || pendingCall);

                if (!callModalVisible && !incomingVisible && !hasActiveObjects) {
                    isCallActive = false;
                    isIncomingCall = false;
                } else {
                showNotification('Already in a call', 'warning');
                return;
                }
            }

            try {
                // Get user media first (faster - parallel with call setup)
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: isVideo,
                    audio: {
                        echoCancellation: { ideal: true },
                        noiseSuppression: { ideal: true },
                        autoGainControl: { ideal: true },
                        sampleRate: { ideal: 48000 },
                        sampleSize: { ideal: 16 },
                        channelCount: { ideal: 1 },
                        latency: { ideal: 0.01 },
                        voiceIsolation: { ideal: true }
                    }
                });

                // Send call request immediately after getting media
                conn.send({ type: 'call-request', isVideo: isVideo });

                // Show local video
                const localVideo = document.getElementById('localVideo');
                localVideo.srcObject = localStream;
                localVideo.style.display = isVideo ? 'block' : 'none';

                // Initiate PeerJS media call to the other peer
                const remotePeerId = conn.peer;
                currentCall = peer.call(remotePeerId, localStream, { metadata: { isVideo: isVideo } });

                // Set call active state
                isCallActive = true;
                callStartTime = Date.now();

                // Log outgoing call in chat
                const callType = isVideo ? 'Video call' : 'Voice call';
                displayCallLog(`You called ${peerUsername || 'User'} - ${callType}`, 'outgoing');

                // Handle remote stream
                currentCall.on('stream', (remoteStream) => {
                    const remoteVideo = document.getElementById('remoteVideo');
                    remoteVideo.srcObject = remoteStream;
                    remoteVideo.muted = false;
                    remoteVideo.style.display = 'block';
                    if (!isVideo) {
                        remoteVideo.style.position = 'absolute';
                        remoteVideo.style.width = '1px';
                        remoteVideo.style.height = '1px';
                        remoteVideo.style.opacity = '0';
                        remoteVideo.style.pointerEvents = 'none';
                    }
                    const playPromise = remoteVideo.play?.();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                    document.getElementById('callProfileStatus').textContent = 'On call';
                    startCallTimer();
                    // Start voice activity detection for wave animation
                    startVoiceActivityDetection(remoteStream);
                });

                currentCall.on('close', () => {
                    endCall();
                });

                currentCall.on('error', (err) => {
                    endCall();
                });

                // Show call modal (chat screen stays active underneath)
                showCallModal(isVideo);
                
                // Ensure chat screen is active (so we can return to it)
                document.getElementById('chatScreen').classList.add('active');
                
                // Initialize audio output system
                initAudioOutputSystem();

            } catch (err) {
                let errorMsg = 'Unable to access microphone';
                if (err.name === 'NotAllowedError') {
                    errorMsg = 'Please allow microphone access in browser settings';
                } else if (err.name === 'NotFoundError') {
                    errorMsg = 'No microphone found. Please connect one';
                } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
                    errorMsg = 'Use HTTPS or localhost for microphone access';
                }
                showNotification(errorMsg, 'error');
            }
        }


        function showCallModal(isVideo, isIncoming = false) {
            const modal = document.getElementById('callModal');
            const profileStatus = document.getElementById('callProfileStatus');
            const waveContainer = document.getElementById('waveContainer');
            const avatarLarge = document.getElementById('callAvatar');
            const remoteVideo = document.getElementById('remoteVideo');
            const timer = document.getElementById('callTimer');
            
            modal.classList.add('show');
            modal.style.display = 'flex';
            modal.style.visibility = 'visible';
            modal.style.opacity = '1';
            modal.style.pointerEvents = 'auto';
            
            // Hide mini call indicator when call modal is shown
            const miniCallIndicator = document.getElementById('miniCallIndicator');
            if (miniCallIndicator) {
                miniCallIndicator.style.display = 'none';
            }
            
            // Clear timer initially
            timer.textContent = '';
            
            // Update profile info
            document.getElementById('callProfileName').textContent = peerUsername || 'User';
            document.getElementById('callTopAvatarInitial').textContent = (peerUsername || 'U').charAt(0).toUpperCase();
            document.getElementById('callAvatarInitial').textContent = (peerUsername || 'U').charAt(0).toUpperCase();
            
            if (isIncoming) {
                profileStatus.textContent = 'Incoming call';
            } else {
                profileStatus.textContent = 'Calling...';
            }

            if (isVideo) {
                remoteVideo.style.display = 'block';
                waveContainer.style.display = 'none';
                avatarLarge.style.display = 'none';
            } else {
                remoteVideo.style.display = 'none';
                waveContainer.style.display = 'flex';
                avatarLarge.style.display = 'none';
            }
        }

        function endCall() {
            // Calculate call duration
            let durationText = '';
            if (callStartTime) {
                const duration = Math.floor((Date.now() - callStartTime) / 1000);
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;
                if (minutes > 0) {
                    durationText = `${minutes}m ${seconds}s`;
                } else {
                    durationText = `${seconds}s`;
                }
            }

            // Only send call-ended if we were in an active call
            if ((isCallActive || isIncomingCall) && conn && conn.open) {
                conn.send({ type: 'call-ended' });
            }

            // Log call end if we were in an active call
            if (isCallActive && durationText) {
                displayCallLog(`Call ended - Duration: ${durationText}`);
            }

            // Reset call state flags
            isCallActive = false;
            isIncomingCall = false;

            // Stop local stream
            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }

            // Close the PeerJS call
            if (currentCall) {
                currentCall.close();
                currentCall = null;
            }

            if (pendingCall) {
                try { pendingCall.close(); } catch (e) {}
                pendingCall = null;
            }

            // Hide modals and reset styles
            const callModal = document.getElementById('callModal');
            callModal.classList.remove('show');
            callModal.style.display = 'none';
            callModal.style.visibility = 'visible';
            callModal.style.opacity = '1';
            callModal.style.pointerEvents = 'auto';
            document.getElementById('incomingCallModal').classList.remove('show');
            
            // Hide mini call indicator when call ends
            const miniCallIndicator = document.getElementById('miniCallIndicator');
            if (miniCallIndicator) {
                miniCallIndicator.style.display = 'none';
            }

            // Stop timer
            if (callTimer) {
                clearInterval(callTimer);
                callTimer = null;
            }
            callStartTime = null;

            // Stop ringtone if playing
            stopRingtone();
            
            // Stop voice activity detection
            stopVoiceActivityDetection();

            // Reset UI
            const localVideo = document.getElementById('localVideo');
            const remoteVideo = document.getElementById('remoteVideo');
            if (localVideo) {
                localVideo.style.display = 'none';
                localVideo.srcObject = null;
            }
            if (remoteVideo) {
                remoteVideo.style.display = 'none';
                remoteVideo.srcObject = null;
            }
            document.getElementById('callTimer').textContent = '';
            
            // Reset status and mute button
            document.getElementById('callProfileStatus').textContent = 'Calling...';
            document.getElementById('callProfileStatus').style.color = 'rgba(255,255,255,0.7)';
            isMuted = false;
            const muteBtn = document.getElementById('muteBtn');
            if (muteBtn) {
                muteBtn.classList.remove('muted');
                muteBtn.querySelector('.btn-icon').innerHTML = '<i class="fas fa-microphone"></i>';
                muteBtn.querySelector('span').textContent = 'Mute';
            }
            
            // Reset remote mute indicator
            const remoteMuteIndicator = document.getElementById('remoteMuteIndicator');
            if (remoteMuteIndicator) {
                remoteMuteIndicator.style.display = 'none';
            }
            
            // Reset local status
            const localStatus = document.getElementById('localStatus');
            if (localStatus) {
                localStatus.style.display = 'none';
            }
            
            // miniCallIndicator already hidden above
        }

        // Go to chat while staying in call
        function goToChat() {
            const callModal = document.getElementById('callModal');
            const miniIndicator = document.getElementById('miniCallIndicator');
            
            // Hide call modal visually but keep call alive
            callModal.classList.remove('show');
            callModal.style.visibility = 'hidden';
            callModal.style.opacity = '0';
            callModal.style.pointerEvents = 'none';
            
            // Show mini call indicator in chat
            if (miniIndicator) {
                miniIndicator.style.display = 'flex';
            }
        }
        
        // Go back to call window from chat
        function goToCall() {
            const callModal = document.getElementById('callModal');
            const miniIndicator = document.getElementById('miniCallIndicator');
            
            // Show call modal
            callModal.classList.add('show');
            callModal.style.visibility = 'visible';
            callModal.style.opacity = '1';
            callModal.style.pointerEvents = 'auto';
            
            // Hide mini indicator
            if (miniIndicator) {
                miniIndicator.style.display = 'none';
            }
        }

        // Update local status indicator (mute, speaker mode)
        function updateLocalStatus(status) {
            const localStatus = document.getElementById('localStatus');
            const localStatusText = document.getElementById('localStatusText');
            const localStatusIcon = document.getElementById('localStatusIcon');
            
            if (!localStatus || !localStatusText) return;
            
            if (status) {
                localStatus.style.display = 'flex';
                localStatusText.textContent = status;
                // Set appropriate icon based on status
                if (localStatusIcon) {
                    if (status === 'Muted') {
                        localStatusIcon.className = 'fas fa-microphone-slash';
                    } else if (status === 'Speaker On') {
                        localStatusIcon.className = 'fas fa-volume-up';
                    } else if (status === 'Earphone' || status === 'Bluetooth') {
                        localStatusIcon.className = 'fas fa-headphones';
                    } else {
                        localStatusIcon.className = 'fas fa-info-circle';
                    }
                }
            } else {
                localStatus.style.display = 'none';
            }
        }

        function toggleMute() {
            isMuted = !isMuted;
            const btn = document.getElementById('muteBtn');
            const iconDiv = btn.querySelector('.btn-icon');
            const label = btn.querySelector('span');
            
            if (localStream) {
                localStream.getAudioTracks().forEach(track => {
                    track.enabled = !isMuted;
                });
            }

            if (isMuted) {
                btn.classList.add('muted');
                iconDiv.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                label.textContent = 'Unmute';
                updateLocalStatus('Muted');
            } else {
                btn.classList.remove('muted');
                iconDiv.innerHTML = '<i class="fas fa-microphone"></i>';
                label.textContent = 'Mute';
                updateLocalStatus(currentAudioOutput === 'speaker' ? 'Speaker On' : null);
            }
            
            // Send mute status to other peer
            if (conn && conn.open) {
                conn.send({ type: 'mute-status', isMuted: isMuted });
            }
        }

        function toggleVideo() {
            isVideoOff = !isVideoOff;
            const btn = document.getElementById('videoBtn');
            
            if (localStream) {
                localStream.getVideoTracks().forEach(track => {
                    track.enabled = !isVideoOff;
                });
            }

            if (isVideoOff) {
                btn.classList.add('active');
                btn.innerHTML = '<i class="fas fa-video-slash"></i>';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '<i class="fas fa-video"></i>';
            }
        }

        // Smart Audio Output System with Auto-Detection
        let currentAudioOutput = 'speaker'; // 'speaker', 'earphone', 'bluetooth'
        let audioDropdownOpen = false;
        let deviceChangeListenerAdded = false;

        // Toggle audio dropdown
        function toggleAudioDropdown() {
            const dropdown = document.getElementById('audioDropdown');
            audioDropdownOpen = !audioDropdownOpen;
            dropdown.style.display = audioDropdownOpen ? 'block' : 'none';
            
            // Update active state and visibility in dropdown
            if (audioDropdownOpen) {
                // Refresh device detection before showing
                detectAudioDevices().then(() => {
                    document.querySelectorAll('.audio-option').forEach(opt => opt.classList.remove('active'));
                    const activeOption = document.getElementById('option' + currentAudioOutput.charAt(0).toUpperCase() + currentAudioOutput.slice(1));
                    if (activeOption) activeOption.classList.add('active');
                });
            }
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const container = document.querySelector('.audio-dropdown-container');
            if (container && !container.contains(e.target)) {
                document.getElementById('audioDropdown').style.display = 'none';
                audioDropdownOpen = false;
            }
        });

        // Set audio output mode
        async function setAudioOutput(mode) {
            currentAudioOutput = mode;
            updateAudioOutputUI();
            
            // Close dropdown
            document.getElementById('audioDropdown').style.display = 'none';
            audioDropdownOpen = false;
            
            // Apply audio routing
            try {
                const remoteVideo = document.getElementById('remoteVideo');
                
                if (mode === 'speaker') {
                    // Route to speaker
                    if (remoteVideo) remoteVideo.muted = false;
                    if ('audioSession' in navigator) {
                        navigator.audioSession.type = 'playback';
                    }
                    showNotification('Audio: Speaker', 'info');
                    // Show speaker status
                    if (!isMuted) {
                        updateLocalStatus('Speaker On');
                    }
                } else {
                    // Route to earphone/bluetooth
                    if (remoteVideo) remoteVideo.muted = false;
                    if ('audioSession' in navigator) {
                        navigator.audioSession.type = 'call';
                    }
                    showNotification(mode === 'bluetooth' ? 'Audio: Bluetooth' : 'Audio: Earphone', 'info');
                    // Hide speaker status
                    if (!isMuted) {
                        updateLocalStatus(null);
                    }
                }
                
            } catch (err) {
                // Silent fail
            }
        }

        // Update audio output button UI
        function updateAudioOutputUI() {
            const iconDiv = document.getElementById('audioOutputIcon');
            const label = document.getElementById('audioOutputLabel');
            const btn = document.getElementById('audioOutputBtn');
            
            // Update icon and label based on mode
            switch(currentAudioOutput) {
                case 'speaker':
                    iconDiv.innerHTML = '<i class="fas fa-volume-up"></i>';
                    label.textContent = 'Speaker';
                    btn.classList.add('active');
                    break;
                case 'earphone':
                    iconDiv.innerHTML = '<i class="fas fa-headphones"></i>';
                    label.textContent = 'Earphone';
                    btn.classList.remove('active');
                    break;
                case 'bluetooth':
                    iconDiv.innerHTML = '<i class="fab fa-bluetooth-b"></i>';
                    label.textContent = 'Bluetooth';
                    btn.classList.remove('active');
                    break;
            }
        }

        // Track available audio devices
        let availableAudioDevices = {
            speaker: true, // Always available
            earphone: false,
            bluetooth: false
        };

        // Auto-detect audio output devices
        async function detectAudioDevices() {
            try {
                // Get all audio output devices
                const devices = await navigator.mediaDevices.enumerateDevices();
                const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
                
                // Check for Bluetooth (typically has "Bluetooth" in label or is a wireless device)
                const bluetoothDevice = audioOutputs.find(d => 
                    d.label.toLowerCase().includes('bluetooth') ||
                    d.label.toLowerCase().includes('airpods') ||
                    d.label.toLowerCase().includes('wireless') ||
                    d.label.toLowerCase().includes('tws')
                );
                
                // Check for wired earphones/headphones (typically has "headphone", "earphone", "headset" in label)
                const earphoneDevice = audioOutputs.find(d =>
                    (d.label.toLowerCase().includes('headphone') ||
                     d.label.toLowerCase().includes('earphone') ||
                     d.label.toLowerCase().includes('headset') ||
                     d.label.toLowerCase().includes('earbud')) &&
                    !d.label.toLowerCase().includes('bluetooth')
                );
                
                // Update available devices
                availableAudioDevices.bluetooth = !!(bluetoothDevice && bluetoothDevice.deviceId !== 'default');
                availableAudioDevices.earphone = !!(earphoneDevice && earphoneDevice.deviceId !== 'default');
                
                // Auto-switch logic
                if (availableAudioDevices.bluetooth) {
                    if (currentAudioOutput !== 'bluetooth') {
                        currentAudioOutput = 'bluetooth';
                        updateAudioOutputUI();
                        showNotification('Bluetooth earphones detected', 'info');
                    }
                } else if (availableAudioDevices.earphone) {
                    if (currentAudioOutput !== 'earphone') {
                        currentAudioOutput = 'earphone';
                        updateAudioOutputUI();
                        showNotification('Wired earphones detected', 'info');
                    }
                } else {
                    // No external device - switch to speaker if not already
                    if (currentAudioOutput !== 'speaker') {
                        currentAudioOutput = 'speaker';
                        updateAudioOutputUI();
                    }
                }
                
                // Update dropdown visibility
                updateAudioDropdownVisibility();
                
            } catch (err) {
                // Silent fail
            }
        }

        // Update dropdown options visibility based on available devices
        function updateAudioDropdownVisibility() {
            const earphoneOption = document.getElementById('optionEarphone');
            const bluetoothOption = document.getElementById('optionBluetooth');
            
            if (earphoneOption) {
                earphoneOption.style.display = availableAudioDevices.earphone ? 'flex' : 'none';
            }
            if (bluetoothOption) {
                bluetoothOption.style.display = availableAudioDevices.bluetooth ? 'flex' : 'none';
            }
        }

        // Listen for device changes (plug/unplug events)
        function setupDeviceChangeListener() {
            if (deviceChangeListenerAdded) return;
            
            navigator.mediaDevices.addEventListener('devicechange', async () => {
                await detectAudioDevices();
            });
            
            deviceChangeListenerAdded = true;
        }

        // Initialize audio output system when call starts
        function initAudioOutputSystem() {
            setupDeviceChangeListener();
            detectAudioDevices();
            updateAudioOutputUI();
        }

        // Voice Activity Detection for wave animation
        let voiceActivityAnalyzer = null;
        let voiceActivityInterval = null;
        
        function startVoiceActivityDetection(stream) {
            try {
                // Create audio context for analysis
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const source = audioContext.createMediaStreamSource(stream);
                const analyser = audioContext.createAnalyser();
                
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.8;
                source.connect(analyser);
                
                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                const waves = document.querySelectorAll('.wave');
                
                // Clear any existing interval
                if (voiceActivityInterval) {
                    clearInterval(voiceActivityInterval);
                }
                
                voiceActivityInterval = setInterval(() => {
                    analyser.getByteFrequencyData(dataArray);
                    
                    // Calculate average volume
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        sum += dataArray[i];
                    }
                    const average = sum / dataArray.length;
                    
                    // Normalize volume (0-100)
                    const volume = Math.min(100, Math.max(0, average * 1.5));
                    
                    // Update wave heights based on volume
                    waves.forEach((wave, index) => {
                        if (volume > 10) {
                            // Sound detected - animate based on volume
                            const baseHeight = [20, 40, 60, 40, 20][index];
                            const scale = 0.5 + (volume / 100) * 0.8;
                            const newHeight = baseHeight * scale;
                            wave.style.height = `${newHeight}px`;
                            wave.style.opacity = 0.5 + (volume / 200);
                        } else {
                            // No sound - minimal height
                            const baseHeight = [10, 15, 20, 15, 10][index];
                            wave.style.height = `${baseHeight}px`;
                            wave.style.opacity = 0.3;
                        }
                    });
                }, 50); // Update every 50ms for smooth animation
                
                voiceActivityAnalyzer = { audioContext, source, analyser };
                
            } catch (err) {
                // Silent fail
            }
        }
        
        function stopVoiceActivityDetection() {
            if (voiceActivityInterval) {
                clearInterval(voiceActivityInterval);
                voiceActivityInterval = null;
            }
            if (voiceActivityAnalyzer) {
                try {
                    voiceActivityAnalyzer.source.disconnect();
                    voiceActivityAnalyzer.audioContext.close();
                } catch (e) {}
                voiceActivityAnalyzer = null;
            }
            // Reset waves to default
            const waves = document.querySelectorAll('.wave');
            const baseHeights = [20, 40, 60, 40, 20];
            waves.forEach((wave, index) => {
                wave.style.height = `${baseHeights[index]}px`;
                wave.style.opacity = 0.5;
            });
        }

        let pendingCall = null;
        
        function showIncomingCall(call, peerName) {
            // If we are already calling (call request already sent), auto-accept this incoming call
            // This handles the case where both users click call at the same time
            if (isCallActive) {
                answerCall(call);
                return;
            }

            // If already in an incoming call, decline the new one
            if (isIncomingCall) {
                call.close();
                return;
            }

            pendingCall = call;
            isIncomingCall = true;
            
            document.getElementById('incomingName').textContent = peerName || 'Unknown';
            document.getElementById('incomingAvatar').textContent = (peerName || '?').charAt(0).toUpperCase();
            document.getElementById('incomingCallModal').classList.add('show');
            
            // Play ringtone
            playRingtone();
            
            // Auto-decline after 45 seconds with not lifting message
            setTimeout(() => {
                if (pendingCall && document.getElementById('incomingCallModal').classList.contains('show')) {
                    const callerName = peerName || 'User';
                    showNotification(`${callerName} is not lifting the call`, 'warning');
                    declineCall();
                }
            }, 45000);
        }
        
        function acceptCall() {
            if (!pendingCall) return;
            
            // Update state - now in active call
            isIncomingCall = false;
            isCallActive = true;
            
            // Log incoming call in chat
            const isVideo = pendingCall.metadata?.isVideo || false;
            const callType = isVideo ? 'Video call' : 'Voice call';
            displayCallLog(`${peerUsername || 'User'} called you - ${callType}`, 'incoming');
            
            // Stop ringtone
            stopRingtone();
            
            // Hide incoming modal
            document.getElementById('incomingCallModal').classList.remove('show');
            
            // Answer the call
            answerCall(pendingCall);
            pendingCall = null;
        }
        
        function declineCall(reason = 'manual') {
            if (!pendingCall) return;
            
            // Reset state
            isIncomingCall = false;
            
            // Stop ringtone
            stopRingtone();
            
            // Close the call
            pendingCall.close();
            pendingCall = null;
            
            // Hide incoming modal
            document.getElementById('incomingCallModal').classList.remove('show');
            
            // Notify caller that we declined
            if (conn && conn.open) {
                conn.send({ type: 'call-declined', reason: reason });
            }
            
            const msg = reason === 'timeout' ? 'Call timeout - not answered' : 'Call declined';
            showNotification(msg, 'info');
        }
        
        async function answerCall(call) {
            const isVideo = call.metadata?.isVideo || false;
            currentCall = call;
            
            // Update state - now in active call
            isIncomingCall = false;
            isCallActive = true;
            
            try {
                // Get user media with specific audio constraints
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: isVideo,
                    audio: {
                        echoCancellation: { ideal: true },
                        noiseSuppression: { ideal: true },
                        autoGainControl: { ideal: true },
                        sampleRate: { ideal: 48000 },
                        sampleSize: { ideal: 16 },
                        channelCount: { ideal: 1 },
                        latency: { ideal: 0.01 },
                        voiceIsolation: { ideal: true }
                    }
                });
                
                // Answer the call
                call.answer(localStream);
                
                // Show call modal (chat screen stays active underneath)
                showCallModal(isVideo, true);
                
                // Ensure chat screen is active (so we can return to it)
                document.getElementById('chatScreen').classList.add('active');
                
                // Initialize audio output system
                initAudioOutputSystem();
                
                // Handle remote stream
                call.on('stream', (remoteStream) => {
                    const remoteVideo = document.getElementById('remoteVideo');
                    if (remoteVideo) {
                        remoteVideo.srcObject = remoteStream;
                        remoteVideo.muted = false;
                        remoteVideo.style.display = isVideo ? 'block' : 'none';
                        const playPromise = remoteVideo.play?.();
                        if (playPromise && typeof playPromise.catch === 'function') {
                            playPromise.catch(() => {});
                        }
                    }
                    document.getElementById('callProfileStatus').textContent = 'On call';
                    startCallTimer();
                    // Start voice activity detection for wave animation
                    startVoiceActivityDetection(remoteStream);
                });
                
                call.on('close', () => endCall());
                call.on('error', () => endCall());
                
            } catch (err) {
                let errorMsg = 'Unable to access microphone';
                if (err.name === 'NotAllowedError') {
                    errorMsg = 'Please allow microphone access in browser settings';
                } else if (err.name === 'NotFoundError') {
                    errorMsg = 'No microphone found';
                } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
                    errorMsg = 'Use HTTPS or localhost for microphone access';
                }
                showNotification(errorMsg, 'error');
                call.close();
            }
        }
        
        let ringtoneTimeout = null;
        let ringCount = 0;
        let ringStartTime = 0;
        
        function playRingtone() {
            // Stop any existing ringtone first
            stopRingtone();
            
            // Reset counter
            ringCount = 0;
            ringStartTime = Date.now();
            
            // Start the ringtone loop
            scheduleNextRing();
        }
        
        function scheduleNextRing() {
            // Check if we should stop (15 rings = 45 seconds)
            if (ringCount >= 15) {
                stopRingtone();
                return;
            }
            
            // Play the ring pattern
            playRingPattern(ringCount);
            ringCount++;
            
            // Calculate next ring time based on actual elapsed time
            const elapsed = Date.now() - ringStartTime;
            const expectedTime = ringCount * 3000; // Every 3 seconds
            const delay = Math.max(0, expectedTime - elapsed);
            
            // Schedule next ring
            ringtoneTimeout = setTimeout(scheduleNextRing, delay);
        }
        
        function playRingPattern(count) {
            try {
                // Create fresh audio context for each ring pattern
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const ctx = new AudioContext();
                
                // Wave intensity pattern: 100,80,60,60,80,100
                const intensityPattern = [1.0, 0.8, 0.6, 0.6, 0.8, 1.0];
                const baseVolume = 0.4 * intensityPattern[count % intensityPattern.length];
                
                const now = ctx.currentTime;
                
                // Unique 4-tone ascending pattern (E pentatonic scale)
                // Creates a musical "ding-ding-ding-DING" sound
                function playTone(freq, delay, duration, vol) {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    
                    osc.frequency.value = freq;
                    osc.type = 'sine';
                    
                    // Smooth envelope
                    gain.gain.setValueAtTime(0, now + delay);
                    gain.gain.linearRampToValueAtTime(vol * baseVolume, now + delay + 0.03);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);
                    
                    osc.start(now + delay);
                    osc.stop(now + delay + duration);
                }
                
                // Play the 4-tone melody
                playTone(659.25, 0, 0.35, 1.0);      // E5 - Rich mid
                playTone(739.99, 0.18, 0.35, 0.9);   // F#5 - Rising
                playTone(880.00, 0.36, 0.35, 0.85);  // A5 - Building
                playTone(1174.66, 0.54, 0.55, 1.0);  // E6 - Climax
                playTone(1174.66, 1.12, 0.4, 0.4);   // Echo
                
                // Close context after pattern finishes
                setTimeout(() => {
                    try { ctx.close(); } catch(e) {}
                }, 1600);
                
            } catch (e) {
                // Silent fail
            }
        }
        
        function stopRingtone() {
            if (ringtoneTimeout) {
                clearTimeout(ringtoneTimeout);
                ringtoneTimeout = null;
            }
            ringCount = 0;
        }
        
        // Audio device selection
        async function selectAudioDevice(deviceId) {
            try {
                const constraints = {
                    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
                    video: false
                };
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                
                // Replace audio track in current call
                if (currentCall && localStream) {
                    const audioTrack = stream.getAudioTracks()[0];
                    const sender = currentCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        sender.replaceTrack(audioTrack);
                    }
                    
                    // Stop old tracks
                    localStream.getAudioTracks().forEach(track => track.stop());
                    localStream = stream;
                }
            } catch (err) {
                // Silent fail
            }
        }
        
        // List available audio devices
        async function listAudioDevices() {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const audioDevices = devices.filter(d => d.kind === 'audioinput');
                return audioDevices;
            } catch (err) {
                return [];
            }
        }

        function startCallTimer() {
            callStartTime = Date.now();
            
            // Show timer immediately
            const timer = document.getElementById('callTimer');
            const miniTimer = document.getElementById('miniCallTimer');
            timer.textContent = '00:00';
            timer.style.display = 'block';
            if (miniTimer) miniTimer.textContent = '00:00';
            
            callTimer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                const timeText = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                timer.textContent = timeText;
                if (miniTimer) miniTimer.textContent = timeText;
            }, 1000);
        }

        // Utility Functions
        function handleInputKeydown(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        }

        function copyRoomCode() {
            if (!roomCode) {
                showNotification('Create a room first!', 'error');
                return;
            }
            navigator.clipboard.writeText(roomCode).then(() => {
                showNotification('Room code copied! Share: ' + roomCode, 'success');
                const btn = document.querySelector('button[onclick="copyRoomCode()"]');
                if (btn) {
                    const original = btn.innerHTML;
                    btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                    setTimeout(() => btn.innerHTML = original, 2000);
                }
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function updateAppHeight() {
            const vv = window.visualViewport;
            const h = vv?.height || window.innerHeight;
            document.documentElement.style.setProperty('--app-height', `${h}px`);
        }

        window.addEventListener('resize', updateAppHeight);
        window.addEventListener('orientationchange', updateAppHeight);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateAppHeight);
            window.visualViewport.addEventListener('scroll', updateAppHeight);
        }
        updateAppHeight();

        // Toggle chat sounds mute
        function toggleMuteSounds() {
            chatSoundsMuted = !chatSoundsMuted;
            const icon = document.getElementById('muteSoundsIcon');
            const text = document.getElementById('muteSoundsText');
            
            if (chatSoundsMuted) {
                icon.className = 'fas fa-volume-mute';
                text.textContent = 'Unmute Sounds';
                showNotification('Chat sounds muted', 'info');
            } else {
                icon.className = 'fas fa-volume-up';
                text.textContent = 'Mute Sounds';
                showNotification('Chat sounds unmuted', 'info');
            }
        }

        // Play message notification sound (unique - 3 tone chime)
        function playMessageSound() {
            if (chatSoundsMuted) return;
            
            try {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const now = audioContext.currentTime;
                
                // Three tone ascending chime (unique sound)
                const frequencies = [523.25, 659.25, 783.99]; // C5, E5, G5 (major triad)
                const durations = [0.08, 0.08, 0.15];
                const delays = [0, 0.08, 0.16];
                
                frequencies.forEach((freq, i) => {
                    const osc = audioContext.createOscillator();
                    const gain = audioContext.createGain();
                    
                    osc.connect(gain);
                    gain.connect(audioContext.destination);
                    
                    osc.frequency.value = freq;
                    osc.type = 'sine';
                    
                    gain.gain.setValueAtTime(0, now + delays[i]);
                    gain.gain.linearRampToValueAtTime(0.15, now + delays[i] + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + delays[i] + durations[i]);
                    
                    osc.start(now + delays[i]);
                    osc.stop(now + delays[i] + durations[i]);
                });
            } catch (err) {
                // Silent fail
            }
        }

        function showNotification(message, type = 'info') {
            const existing = document.getElementById('toastContainer');
            const container = existing || (() => {
                const el = document.createElement('div');
                el.id = 'toastContainer';
                el.style.position = 'fixed';
                el.style.top = '16px';
                el.style.left = '50%';
                el.style.transform = 'translateX(-50%)';
                el.style.zIndex = '20000';
                el.style.display = 'flex';
                el.style.flexDirection = 'column';
                el.style.gap = '8px';
                el.style.pointerEvents = 'none';
                document.body.appendChild(el);
                return el;
            })();

            const toast = document.createElement('div');
            const bg = type === 'error' ? 'var(--danger)' : type === 'warning' ? 'var(--warning)' : type === 'success' ? 'var(--success)' : 'var(--accent)';
            toast.style.background = bg;
            toast.style.color = 'white';
            toast.style.padding = '10px 14px';
            toast.style.borderRadius = '12px';
            toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
            toast.style.fontSize = '13px';
            toast.style.fontWeight = '600';
            toast.style.maxWidth = '90vw';
            toast.style.pointerEvents = 'none';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            toast.style.transition = 'opacity 180ms ease, transform 180ms ease';
            toast.textContent = message;

            container.appendChild(toast);

            requestAnimationFrame(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translateY(0)';
            });

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(-6px)';
                setTimeout(() => toast.remove(), 250);
            }, 2500);
        }

        // Load saved theme
        window.addEventListener('DOMContentLoaded', () => {
            // Auto-resize textarea - moved inside DOMContentLoaded
            const messageInput = document.getElementById('messageInput');
            if (messageInput) {
                messageInput.addEventListener('input', function() {
                    this.style.height = 'auto';
                    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
                });
            }

            const savedTheme = localStorage.getItem('chat-theme') || 'light';
            document.documentElement.setAttribute('data-theme', savedTheme);

            // Connect to Socket.io for presence tracking
            connectSocket();

            // Register Service Worker for push notifications
            registerPushNotifications();

            // Check room online status when user types room code
            const roomCodeInput = document.getElementById('roomCodeInput');
            if (roomCodeInput) {
                roomCodeInput.addEventListener('input', function() {
                    const code = this.value.trim().toUpperCase();
                    if (code.length === 8) {
                        checkRoomOnline(code, (data) => {
                            const statusDiv = document.getElementById('roomOnlineStatus');
                            const countSpan = document.getElementById('roomOnlineCount');
                            if (data.online) {
                                statusDiv.style.display = 'flex';
                                countSpan.textContent = data.count + ' Online';
                            } else {
                                statusDiv.style.display = 'none';
                            }
                        });
                    } else {
                        document.getElementById('roomOnlineStatus').style.display = 'none';
                    }
                });
            }

            // Restore session if exists
            setTimeout(() => {
                const session = loadSession();
                if (session && session.username && session.roomCode) {
                    username = session.username;
                    roomCode = session.roomCode;
                    isCreator = session.isCreator;
                    peerUsername = session.peerUsername || '';

                    // Show chat screen immediately
                    document.getElementById('setupScreen').classList.remove('active');
                    document.getElementById('chatScreen').classList.add('active');
                    document.getElementById('peerName').textContent = peerUsername || 'Reconnecting...';
                    document.getElementById('avatarInitial').textContent = (peerUsername || '?').charAt(0).toUpperCase();
                    document.getElementById('peerStatus').textContent = 'reconnecting';
                    document.getElementById('onlineIndicator').style.display = 'none';

                    showNotification('Reconnecting...', 'info');

                    // Restore messages from localStorage
                    const savedMessages = loadMessages();
                    savedMessages.forEach(msg => {
                        displayMessage(msg.message, msg.type, msg.msgId, msg.replyMeta, true);
                    });

                    // Auto-reconnect with retry logic
                    isRestoringSession = true;
                    let retryCount = 0;
                    const maxRetries = 9999; // Keep trying indefinitely

                    function attemptReconnect() {
                        if (retryCount >= maxRetries) return;

                        retryCount++;

                        if (isCreator) {
                            createRoom().then(() => {
                                isRestoringSession = false;
                                showNotification('Reconnected!', 'success');
                                if (reconnectionInterval) {
                                    clearInterval(reconnectionInterval);
                                    reconnectionInterval = null;
                                }
                            }).catch(() => {
                                document.getElementById('peerStatus').textContent = 'reconnecting';
                                // Retry after 3 seconds
                            });
                        } else {
                            joinRoom().then(() => {
                                isRestoringSession = false;
                                showNotification('Reconnected!', 'success');
                                if (reconnectionInterval) {
                                    clearInterval(reconnectionInterval);
                                    reconnectionInterval = null;
                                }
                            }).catch(() => {
                                document.getElementById('peerStatus').textContent = 'reconnecting';
                                // Retry after 3 seconds
                            });
                        }
                    }

                    // Start reconnection attempts
                    setTimeout(attemptReconnect, 500);

                    // Retry every 5 seconds until successful
                    reconnectionInterval = setInterval(() => {
                        if (conn && conn.open) {
                            clearInterval(reconnectionInterval);
                            reconnectionInterval = null;
                            isRestoringSession = false;
                        } else {
                            attemptReconnect();
                        }
                    }, 5000);
                }
            }, 500);
        });