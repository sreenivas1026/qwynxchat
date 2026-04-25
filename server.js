const { createServer } = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const fs = require('fs');

// Load VAPID keys
let vapidKeys;
try {
    vapidKeys = JSON.parse(fs.readFileSync('./vapid-keys.json', 'utf8'));
    webpush.setVapidDetails(
        'mailto:your-email@example.com',
        vapidKeys.publicKey,
        vapidKeys.privateKey
    );
} catch (e) {
    console.log('VAPID keys not found. Push notifications will not work.');
}

const httpServer = createServer();
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Track online users by room code
const onlineUsers = new Map(); // roomCode -> Set of socketIds
// Track push subscriptions by room code
const pushSubscriptions = new Map(); // roomCode -> Array of subscriptions

io.on('connection', (socket) => {
    socket.on('join', ({ roomCode, username }) => {
        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.username = username;

        // Track user
        if (!onlineUsers.has(roomCode)) {
            onlineUsers.set(roomCode, new Set());
        }
        onlineUsers.get(roomCode).add(socket.id);

        // Notify others in room via Socket.io
        socket.to(roomCode).emit('user-online', { username });

        // Send push notification to offline users
        sendPushNotification(roomCode, `${username} is online`, 'Someone joined the chat');
    });

    socket.on('register-push', ({ roomCode, subscription }) => {
        if (!pushSubscriptions.has(roomCode)) {
            pushSubscriptions.set(roomCode, []);
        }
        pushSubscriptions.get(roomCode).push(subscription);
    });

    socket.on('message-sent', ({ roomCode, username, message }) => {
        // Send push notification to offline users in the room
        sendPushNotification(roomCode, `${username}: ${message}`, 'New message');
    });

    socket.on('disconnect', () => {
        const { roomCode, username } = socket.data;
        if (roomCode) {
            // Remove from tracking
            const users = onlineUsers.get(roomCode);
            if (users) {
                users.delete(socket.id);
                if (users.size === 0) {
                    onlineUsers.delete(roomCode);
                }
            }

            // Notify others via Socket.io
            socket.to(roomCode).emit('user-offline', { username });

            // Send push notification to offline users
            sendPushNotification(roomCode, `${username} is offline`, 'Someone left the chat');
        }
    });

    socket.on('check-online', ({ roomCode }, callback) => {
        const users = onlineUsers.get(roomCode);
        callback({ online: users ? users.size > 0 : false, count: users ? users.size : 0 });
    });
});

// Send push notification to all subscribers in a room
async function sendPushNotification(roomCode, title, body) {
    if (!vapidKeys) return;

    const subscriptions = pushSubscriptions.get(roomCode) || [];
    const notificationPayload = JSON.stringify({
        title: 'QwynxChat',
        body: body,
        icon: '/favicon.ico'
    });

    for (const subscription of subscriptions) {
        try {
            await webpush.sendNotification(subscription, notificationPayload);
        } catch (error) {
            console.error('Push notification error:', error);
        }
    }
}

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
    console.log(`Socket.io server running on port ${PORT}`);
});

module.exports = { httpServer, io };
