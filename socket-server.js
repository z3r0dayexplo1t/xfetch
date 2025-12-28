/**
 * WebSocket server implementation using emit.gg
 * Handles communication between extension and xfetch clients
 */

const { EmitApp } = require('emit.gg');
const heartbeat = require('emit.gg/plugins/heartbeat');

// Server configuration
const PORT = process.env.PORT || 3006;

// Create emit.gg app
const app = new EmitApp();

// Add heartbeat plugin for connection health monitoring
app.plugin(heartbeat({ interval: 3000 }));

/**
 * Server statistics tracking
 */
const stats = {
    requestsProcessed: 0,
    requestsSucceeded: 0,
    requestsFailed: 0,
    startTime: Date.now(),
    extensionClients: 0,
    xfetchClients: 0,
};

/**
 * Pending requests waiting for extension clients
 */
const pendingRequests = new Map();

/**
 * Middleware: Log all events
 */
app.use((req, next) => {
    console.log(`[${req.socket.id}] ${req.event}`, req.data ? `(${JSON.stringify(req.data).substring(0, 100)})` : '');
    next();
});

/**
 * System Event: Client connected
 */
app.on('@connection', ({ socket, app, info }) => {
    console.log(`Client connected: ${socket.id}`);
    console.log(`  IP: ${info.ip}`);
    console.log(`  Query:`, info.query);

    // Request client identification
    socket.emit('@identify', { message: 'Please identify your client type' });
});

/**
 * System Event: Client disconnected
 */
app.on('@disconnect', ({ socket, app }) => {
    const clientType = socket.data.clientType;
    console.log(`Client disconnected: ${socket.id} (${clientType || 'unknown'})`);

    // Update stats
    if (clientType === 'extension') {
        stats.extensionClients = Math.max(0, stats.extensionClients - 1);
        notifyXfetchClients();
    } else if (clientType === 'xfetch') {
        stats.xfetchClients = Math.max(0, stats.xfetchClients - 1);
    }

    // Clean up pending requests for this client
    for (const [requestId, request] of pendingRequests.entries()) {
        if (request.socketId === socket.id) {
            pendingRequests.delete(requestId);
            stats.requestsFailed++;
        }
    }
});

/**
 * System Event: Heartbeat ping
 */
app.on('@ping', (req) => {
    const clientType = req.get('clientType') || 'unknown';
    console.log(`Heartbeat from ${clientType} client: ${req.id}`);
});

/**
 * Event: Client identification
 */
app.on('/identify', (req) => {
    const { clientType } = req.data;

    if (!clientType || (clientType !== 'extension' && clientType !== 'xfetch')) {
        req.emit('@error', { error: 'Invalid client type. Must be "extension" or "xfetch"' });
        return;
    }

    // Check if this socket already has a client type (re-identification)
    const previousClientType = req.get('clientType');
    const isFirstIdentification = !previousClientType;

    // Store client type
    req.set('clientType', clientType);

    // Add tag for easy filtering
    req.tag(`*${clientType}`);

    // Update stats only on first identification
    if (isFirstIdentification) {
        if (clientType === 'extension') {
            stats.extensionClients++;
        } else if (clientType === 'xfetch') {
            stats.xfetchClients++;
        }

        console.log(`Client ${req.id} identified as ${clientType}`);
        console.log(`  Extension clients: ${stats.extensionClients}`);
        console.log(`  Xfetch clients: ${stats.xfetchClients}`);
    } else {
        console.log(`Client ${req.id} re-identified as ${clientType} (no count change)`);
    }

    // Send confirmation
    req.emit('@identified', { clientType });

    // If this is an xfetch client, tell them about extension availability
    if (clientType === 'xfetch') {
        const available = stats.extensionClients > 0;
        req.emit('@extension-status', { available });
    }

    // If this is the first extension, notify all xfetch clients
    if (clientType === 'extension' && stats.extensionClients === 1) {
        notifyXfetchClients();
    }
});

/**
 * Event: Fetch request from xfetch client
 */
app.on('/fetch', async (req) => {
    const clientType = req.get('clientType');

    // Validate client type
    if (clientType !== 'xfetch') {
        req.reply({ error: 'Only xfetch clients can send fetch requests' });
        return;
    }

    const { url, options, id: requestId } = req.data;

    if (!url || !requestId) {
        req.reply({ error: 'Missing required fields: url, id' });
        return;
    }

    // Check if extension clients are available
    if (stats.extensionClients === 0) {
        // Store request for retry
        storePendingRequest(requestId, req.id, url, options, req);

        // Wait a bit for extensions to connect
        setTimeout(() => retryPendingRequest(requestId), 2000);
        return;
    }

    // Forward request to extension clients
    const sent = await forwardToExtension(requestId, url, options);

    if (!sent) {
        req.reply({ error: 'Failed to forward request to extension' });
        stats.requestsFailed++;
    } else {
        // Store pending request
        pendingRequests.set(requestId, {
            socketId: req.id,
            timestamp: Date.now(),
            url,
            options
        });
    }
});

/**
 * Event: Response from extension client
 */
app.on('/response', (req) => {
    const clientType = req.get('clientType');

    // Validate client type
    if (clientType !== 'extension') {
        req.emit('@error', { error: 'Only extension clients can send responses' });
        return;
    }

    const { id: requestId, response, error } = req.data;

    if (!requestId) {
        req.emit('@error', { error: 'Missing request id' });
        return;
    }

    // Find the pending request
    const pendingRequest = pendingRequests.get(requestId);

    if (!pendingRequest) {
        console.log(`Received response for unknown request: ${requestId}`);
        return;
    }

    // Update stats
    stats.requestsProcessed++;
    if (response) {
        stats.requestsSucceeded++;
    } else {
        stats.requestsFailed++;
    }

    const responseTime = Date.now() - pendingRequest.timestamp;
    console.log(`Request ${requestId} completed in ${responseTime}ms`);

    // Forward response to xfetch client
    emitToSocket(pendingRequest.socketId, '/fetch-response', {
        id: requestId,
        response,
        error
    });

    // Clean up
    pendingRequests.delete(requestId);
});

/**
 * Event: Get server stats
 */
app.on('/stats', (req) => {
    req.reply({
        ...stats,
        uptime: Date.now() - stats.startTime,
        pendingRequests: pendingRequests.size,
    });
});

/**
 * Helper: Send message to specific socket by ID
 */
function emitToSocket(socketId, event, data) {
    for (const socket of app.sockets) {
        if (socket.id === socketId) {
            socket.emit(event, data);
            return true;
        }
    }
    console.warn(`Socket ${socketId} not found`);
    return false;
}

/**
 * Helper: Forward request to extension client
 */
async function forwardToExtension(id, url, options) {
    try {
        // Broadcast to all extension clients (they'll handle it)
        app.broadcast('/fetch-request', {
            data: { id, url, options },
            to: '*extension'
        });
        return true;
    } catch (err) {
        console.error('Error forwarding to extension:', err.message);
        return false;
    }
}

/**
 * Helper: Store pending request for retry
 */
function storePendingRequest(requestId, socketId, url, options, req) {
    if (!pendingRequests.has(requestId)) {
        pendingRequests.set(requestId, {
            socketId,
            timestamp: Date.now(),
            url,
            options,
            retries: 0,
            req
        });
        console.log(`Stored pending request ${requestId} (no extensions available)`);
    }
}

/**
 * Helper: Retry pending request
 */
async function retryPendingRequest(requestId) {
    const pending = pendingRequests.get(requestId);

    if (!pending) {
        return; // Already processed
    }

    pending.retries++;

    if (stats.extensionClients > 0) {
        // Extension is now available, send the request
        console.log(`Retrying pending request ${requestId} (attempt ${pending.retries})`);
        const sent = await forwardToExtension(requestId, pending.url, pending.options);

        if (!sent) {
            // Failed to send, retry or give up
            if (pending.retries < 3) {
                setTimeout(() => retryPendingRequest(requestId), 2000);
            } else {
                // Give up
                emitToSocket(pending.socketId, '/fetch-response', {
                    id: requestId,
                    error: 'Failed to forward request to extension after 3 retries'
                });
                pendingRequests.delete(requestId);
                stats.requestsFailed++;
            }
        }
    } else {
        // Still no extensions, retry or give up
        if (pending.retries < 3) {
            setTimeout(() => retryPendingRequest(requestId), 2000);
        } else {
            // Give up
            emitToSocket(pending.socketId, '/fetch-response', {
                id: requestId,
                error: 'No extension clients available after 3 retry attempts'
            });
            pendingRequests.delete(requestId);
            stats.requestsFailed++;
        }
    }
}

/**
 * Helper: Notify all xfetch clients about extension availability
 */
function notifyXfetchClients() {
    const available = stats.extensionClients > 0;
    console.log(`Notifying xfetch clients: extensions ${available ? 'available' : 'unavailable'}`);

    app.broadcast('@extension-status', {
        data: { available },
        to: '*xfetch'
    });
}

/**
 * Periodic cleanup and stats reporting
 */
setInterval(() => {
    const now = Date.now();

    // Clean up expired requests (older than 2 minutes)
    for (const [id, request] of pendingRequests.entries()) {
        if (now - request.timestamp > 120000) {
            console.log(`Cleaning up expired request: ${id}`);
            pendingRequests.delete(id);
            stats.requestsFailed++;
        }
    }

    // Log stats
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Server Statistics:
  Uptime: ${Math.floor((now - stats.startTime) / 1000)}s
  Extension clients: ${stats.extensionClients}
  Xfetch clients: ${stats.xfetchClients}
  Pending requests: ${pendingRequests.size}
  Requests processed: ${stats.requestsProcessed}
  Requests succeeded: ${stats.requestsSucceeded}
  Requests failed: ${stats.requestsFailed}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
}, 120000); // Every 2 minutes

/**
 * Start the server
 */
app.listen(PORT, () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 xfetch WebSocket server (emit.gg)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Listening on: ws://localhost:${PORT}
   Started at: ${new Date().toISOString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
});

/**
 * Graceful shutdown
 */
process.on('SIGINT', () => {
    console.log('\n\nShutting down server...');
    app.close();
    process.exit(0);
});
