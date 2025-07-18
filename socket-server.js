/**
 * WebSocket server implementation for handling communication between extension and xfetch clients
 * Manages client connections, heartbeats, request routing, and connection health monitoring
 */

const WebSocket = require('ws')
const { v4: uuidv4 } = require('uuid')

// Server configuration
const PORT = process.env.PORT || 3006
const wss = new WebSocket.Server({ port: PORT })

/**
 * Client and request management
 */
const clients = {
    extension: new Map(),
    xfetch: new Map(),
}

const pendingRequests = new Map()
const pendingRequestsQueue = new Map()

/**
 * Server statistics tracking
 */
const stats = {
    requestsProcessed: 0,
    requestsSucceeded: 0,
    requestsFailed: 0,
    startTime: Date.now(),
    connectionStats: {
        totalConnections: 0,
        activeConnections: 0,
        disconnections: 0,
        reconnections: 0,
    },
    heartbeatStats: {
        sent: 0,
        received: 0,
        missed: 0,
    }
}

/**
 * Heartbeat configuration
 */
const HEARTBEAT_CONFIG = {
    interval: 3000,   // Send heartbeat every 3 seconds
    timeout: 5000,    // Wait 5 seconds for pong response
    maxMissed: 3      // Maximum number of missed heartbeats before considering client unhealthy
}

// Log server startup
console.log(`WebSocket server started on port ${PORT}`);

/**
 * Periodic cleanup and stats reporting
 */
const CLEANUP_INTERVAL = 1000 * 60 * 2; // 2 minutes
setInterval(() => {
    const now = Date.now();

    // Clean up expired requests
    for (const [id, request] of pendingRequests.entries()) {
        if (now - request.timestamp > CLEANUP_INTERVAL) {
            pendingRequests.delete(id);
        }
    }

    // Log server statistics
    console.log(`
        Connection stats:
          - Extension clients: ${clients.extension.size}
          - Xfetch clients: ${clients.xfetch.size}
          - Total connections: ${stats.connectionStats.totalConnections}
          - Active connections: ${stats.connectionStats.activeConnections}
          - Disconnections: ${stats.connectionStats.disconnections}
          - Reconnections: ${stats.connectionStats.reconnections}
        Heartbeat stats:
          - Sent: ${stats.heartbeatStats.sent}
          - Received: ${stats.heartbeatStats.received}
          - Missed: ${stats.heartbeatStats.missed}
        Request stats:
          - Pending requests: ${pendingRequests.size}
          - Processed: ${stats.requestsProcessed}
          - Succeeded: ${stats.requestsSucceeded}
          - Failed: ${stats.requestsFailed}
    `);
}, CLEANUP_INTERVAL);

/**
 * Heartbeat management
 */
const heartbeatInterval = setInterval(() => {
    sendHeartbeats('extension');
    sendHeartbeats('xfetch');
    checkClientHealth('extension');
    checkClientHealth('xfetch');
}, HEARTBEAT_CONFIG.interval);

/**
 * Sends heartbeat pings to all clients of a specific type
 */
function sendHeartbeats(clientType) {
    for (const [clientId, clientData] of clients[clientType].entries()) {
        const client = clientData.client;
        if (client.readyState === WebSocket.OPEN) {
            try {
                clientData.lastPingSent = Date.now();
                clientData.awaitingPong = true;

                // Send ping message
                client.send(JSON.stringify({
                    type: 'ping',
                    timestamp: Date.now(),
                    interval: HEARTBEAT_CONFIG.interval,
                    server: 'socket-server' // Identify this as a server ping
                }));

                stats.heartbeatStats.sent++;

                // Set timeout for pong response
                clientData.pongTimeoutId = setTimeout(() => {
                    if (clientData.awaitingPong && clientData.client.readyState === WebSocket.OPEN) {
                        clientData.missedHeartbeats++;
                        stats.heartbeatStats.missed++;
                        clientData.awaitingPong = false;

                        // Update client health status
                        clientData.healthStatus = clientData.missedHeartbeats >= HEARTBEAT_CONFIG.maxMissed
                            ? 'critical'
                            : 'degraded';

                        console.log(`Client ${clientType} ${clientId} missed heartbeat: ${clientData.missedHeartbeats}/${HEARTBEAT_CONFIG.maxMissed}`);
                    }
                }, HEARTBEAT_CONFIG.timeout);
            } catch (err) {
                console.log({
                    type: 'error',
                    from: 'sendHeartbeats',
                    message: err.message
                });
            }
        }
    }
}

/**
 * Checks health of all clients of a specific type
 */
function checkClientHealth(clientType) {
    for (const [clientId, clientData] of clients[clientType].entries()) {
        if (clientData.missedHeartbeats >= HEARTBEAT_CONFIG.maxMissed) {
            if (clientData.pongTimeoutId) {
                clearTimeout(clientData.pongTimeoutId);
            }

            try {
                if (clientData.client.readyState === WebSocket.OPEN) {
                    clientData.client.terminate();
                }
            } catch (err) {
                // Ignore errors when terminating already dead connections
            }

            // Clean up client data and update stats
            clients[clientType].delete(clientId);
            stats.connectionStats.disconnections++;
            stats.connectionStats.activeConnections--;

            // Clean up pending requests for terminated client
            for (const [requestId, request] of pendingRequests.entries()) {
                if (request && request.client && request.client === clientData.client) {
                    pendingRequests.delete(requestId);
                    stats.requestsFailed++;
                }
            }
        }
    }
}

/**
 * Sends a message to the healthiest available extension client
 */
function sendToExtension(message) {
    if (clients.extension.size === 0) {
        return false;
    }

    const msg = JSON.stringify(message);

    // Find the healthiest available extension client
    let bestClient = null;
    let bestHealth = -1;

    for (const [clientId, clientData] of clients.extension.entries()) {
        const client = clientData.client;
        if (client.readyState === WebSocket.OPEN) {
            const healthScore = clientData.healthStatus === 'healthy' ? 2 :
                clientData.healthStatus === 'degraded' ? 1 : 0;

            if (healthScore > bestHealth) {
                bestClient = client;
                bestHealth = healthScore;

                if (healthScore === 2) break; // Found a healthy client, no need to continue
            }
        }
    }

    if (bestClient && bestClient.readyState === WebSocket.OPEN) {
        try {
            bestClient.send(msg);
            return true;
        } catch (err) {
            console.log({
                type: 'error',
                from: 'sendToExtension',
                message: err.message
            });
        }
    }

    return false;
}

/**
 * Sends a message to a specific xfetch client
 */
function sendToXfetch(client, message) {
    if (client.readyState !== WebSocket.OPEN) {
        return false;
    }

    const msg = JSON.stringify(message);
    try {
        client.send(msg);
        return true;
    } catch (err) {
        console.log({
            type: 'error',
            from: 'sendToXfetch',
            message: err.message
        });
        return false;
    }
}

/**
 * Notifies all xfetch clients about extension availability
 */
function notifyXfetchClients(available) {
    const messageType = available ? 'extensionAvailable' : 'extensionUnavailable';
    console.log(`Notifying xfetch clients about ${messageType}`);

    for (const [xfetchId, xfetchData] of clients.xfetch.entries()) {
        const xfetchClient = xfetchData.client;
        if (xfetchClient && xfetchClient.readyState === WebSocket.OPEN) {
            try {
                xfetchClient.send(JSON.stringify({
                    type: messageType,
                    timestamp: Date.now()
                }));
            } catch (err) {
                console.log({
                    type: 'error',
                    from: `notify${available ? 'Available' : 'Unavailable'}`,
                    message: err.message
                });
            }
        }
    }
}

/**
 * Handles pending request validation and routing
 */
function validateExtensionClients(message, ws, clientId, count) {
    if (clients.extension.size === 0 && count < 3) {
        console.log(`No extension clients available, attempt ${count + 1}/3. Waiting 3s for clients...`);

        // Clear any existing timeout for this request ID
        const existingQueueItem = pendingRequestsQueue.get(message.id);
        if (existingQueueItem && existingQueueItem.timeoutId) {
            clearTimeout(existingQueueItem.timeoutId);
        }

        // Add to queue with new timeout - store the full original message
        pendingRequestsQueue.set(message.id, {
            client: ws,
            timestamp: Date.now(),
            id: message.id,
            url: message.url,
            clientId: clientId,
            originalMessage: message,  // Store the entire original message
            timeoutId: setTimeout(() => {
                console.log(`Retry attempt ${count + 1} for request ${message.id}`);
                pendingRequestsQueue.delete(message.id);
                validateExtensionClients(message, ws, clientId, count + 1);
            }, 2000)
        });

        // Don't send any response to the client yet - we're waiting
    } else if (clients.extension.size === 0 && count >= 3) {
        console.log(`Max retries (3) reached for request ${message.id}. No extension clients available.`);
        pendingRequestsQueue.delete(message.id);
        ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({
            id: message.id,
            error: 'No extension clients available after maximum retries',
            response: null
        }));
        pendingRequests.delete(message.id);
        stats.requestsFailed++;
        stats.requestsProcessed++;
    } else if (clients.extension.size > 0) {
        console.log(`Found ${clients.extension.size} extension clients, sending request ${message.id}`);
        const sent = sendToExtension(message);
        if (!sent) {
            console.log(`Failed to send request ${message.id} to extension clients`);
            pendingRequestsQueue.delete(message.id);
            ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({
                id: message.id,
                error: 'Failed to send request to extension clients',
                response: null
            }));
            pendingRequests.delete(message.id);
            stats.requestsFailed++;
            stats.requestsProcessed++;

            if (clients.xfetch.has(clientId)) {
                const clientData = clients.xfetch.get(clientId);
                clientData.requestsProcessed++;
                clientData.requestsFailed++;
                clients.xfetch.set(clientId, clientData);
            }
        } else {
            console.log(`Successfully sent request ${message.id} to extension client`);
        }
    } else {
        console.log(`Unexpected condition for request ${message.id}`);
        pendingRequestsQueue.delete(message.id);
        ws.send(JSON.stringify({
            id: message.id,
            error: 'Unexpected server condition',
            response: null
        }));
        pendingRequests.delete(message.id);
        stats.requestsFailed++;
        stats.requestsProcessed++;
    }
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const clientId = uuidv4();
    ws.id = clientId;
    ws.clientType = 'unknown';

    // Update connection statistics
    stats.connectionStats.totalConnections++;
    stats.connectionStats.activeConnections++;

    // Send welcome message requesting client identification
    ws.send(JSON.stringify({
        type: 'identify',
        message: 'Welcome to the xfetch socket server, please identify yourself'
    }));

    /**
     * Message handler for incoming WebSocket messages
     */
    ws.on('message', (messageData) => {
        try {
            const message = JSON.parse(messageData);

            // Handle heartbeat pong responses
            if (message.type === 'pong') {
                handlePongResponse(ws, clientId);
                return;
            }

            // Handle ping requests from clients
            if (message.type === 'ping') {
                // Send pong response immediately
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: Date.now(),
                    server: 'socket-server' // Identify this as a server response
                }));
                return;
            }

            // Handle client identification
            if (message.clientType === 'xfetch' || message.clientType === 'extension') {
                handleClientIdentification(ws, message, clientId, clientIp);
                return;
            }

            // Handle request messages from xfetch clients
            if (ws.clientType === 'xfetch' && message.url && message.options && message.id !== undefined) {
                handleXfetchRequest(ws, message, clientId);
                return;
            }

            // Handle response messages from extension clients
            if (ws.clientType === 'extension' && message.id !== undefined) {
                handleExtensionResponse(ws, message, clientId);
                return;
            }

        } catch (err) {
            console.log({
                type: 'error',
                from: 'HandleMessage',
                message: err.message
            });
        }
    });

    /**
     * Handler for pong responses
     */
    function handlePongResponse(ws, clientId) {
        const clientType = ws.clientType;
        if (clientType !== 'unknown' && clients[clientType].has(clientId)) {
            const clientData = clients[clientType].get(clientId);

            // Reset heartbeat tracking
            if (clientData.pongTimeoutId) {
                clearTimeout(clientData.pongTimeoutId);
                clientData.pongTimeoutId = null;
            }

            clientData.awaitingPong = false;
            clientData.lastPongReceived = Date.now();
            clientData.lastActivity = Date.now();

            // Restore client health if it was degraded
            if (clientData.missedHeartbeats > 0 && clientData.missedHeartbeats < HEARTBEAT_CONFIG.maxMissed) {
                clientData.healthStatus = 'healthy';
            }

            clientData.missedHeartbeats = 0;
            stats.heartbeatStats.received++;
            clients[clientType].set(clientId, clientData);
        }
    }

    /**
     * Handler for client identification
     */
    function handleClientIdentification(ws, message, clientId, clientIp) {
        const clientType = message.clientType;
        const isReconnection = ws.clientType !== 'unknown';
        ws.clientType = clientType;

        // Initialize client data
        clients[clientType].set(clientId, {
            client: ws,
            id: clientId,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            lastPingSent: null,
            lastPongReceived: null,
            awaitingPong: false,
            missedHeartbeats: 0,
            healthStatus: 'healthy',
            pongTimeoutId: null,
            ipAddress: clientIp,
            requestsProcessed: 0,
            requestsSucceeded: 0,
            requestsFailed: 0,
            avgResponseTime: 0
        });

        if (isReconnection) {
            stats.connectionStats.reconnections++;
        }

        console.log(`Client ${clientType} connected from ${clientIp} with ID ${clientId}`);

        //send identification confirmation
        ws.send(JSON.stringify({ type: 'identified' }));

        if (clientType === 'xfetch') {
            ws.send(JSON.stringify({
                type: clients.extension.size === 1 ? 'extensionAvailable' : 'extensionUnavailable'
            }))
        }

        // If this is an extension client, notify xfetch clients
        if (clientType === 'extension' && clients.extension.size === 1) {
            notifyXfetchClients('extensionAvailable');
        }

    }

    /**
     * Handler for xfetch client requests
     */
    function handleXfetchRequest(ws, message, clientId) {
        // Update client activity
        if (clients.xfetch.has(clientId)) {
            const clientData = clients.xfetch.get(clientId);
            clientData.lastActivity = Date.now();
            clients.xfetch.set(clientId, clientData);
        }

        // Store request details
        pendingRequests.set(message.id, {
            client: ws,
            timestamp: Date.now(),
            id: message.id,
            url: message.url,
            options: message.options,
            clientId: clientId
        });

        // Check if any extension clients are available
        validateExtensionClients(message, ws, clientId, 0);
    }

    /**
     * Handler for extension client responses
     */
    function handleExtensionResponse(ws, message, clientId) {
        // Update client activity
        if (clients.extension.has(clientId)) {
            const clientData = clients.extension.get(clientId);
            clientData.lastActivity = Date.now();
            clients.extension.set(clientId, clientData);
        }

        // Process response
        const pendingRequest = pendingRequests.get(message.id);
        if (pendingRequest) {
            const xfetchClient = pendingRequest.client;
            const requestClientId = pendingRequest.clientId;
            const responseTime = Date.now() - pendingRequest.timestamp;

            // Forward response to xfetch client
            if (xfetchClient && xfetchClient.readyState === WebSocket.OPEN) {
                sendToXfetch(xfetchClient, message);
            }

            // Update global stats
            stats.requestsProcessed++;
            if (message.response) {
                stats.requestsSucceeded++;
            } else {
                stats.requestsFailed++;
            }

            // Update extension client stats
            if (clients.extension.has(clientId)) {
                const clientData = clients.extension.get(clientId);
                clientData.requestsProcessed++;
                if (message.response) {
                    clientData.requestsSucceeded++;
                } else {
                    clientData.requestsFailed++;
                }
                clients.extension.set(clientId, clientData);
            }

            // Update xfetch client stats and response time
            if (requestClientId !== undefined && clients.xfetch.has(requestClientId)) {
                const clientData = clients.xfetch.get(requestClientId);
                clientData.requestsProcessed++;
                if (message.response) {
                    clientData.requestsSucceeded++;
                    // Update average response time with exponential moving average
                    if (clientData.avgResponseTime === 0) {
                        clientData.avgResponseTime = responseTime;
                    } else {
                        clientData.avgResponseTime = 0.7 * clientData.avgResponseTime + 0.3 * responseTime;
                    }
                } else {
                    clientData.requestsFailed++;
                }
                clients.xfetch.set(requestClientId, clientData);
            } else {
                console.log(`No xfetch client found for request ${message.id}`);
            }

            pendingRequests.delete(message.id);
        }
    }

    // Handle client disconnection
    ws.on('close', () => {
        const wasExtension = ws.clientType === 'extension';
        clients[ws.clientType].delete(clientId);

        // Clean up pending requests for disconnected client
        for (const [id, request] of pendingRequests.entries()) {
            if (request.client === ws) {
                pendingRequests.delete(id);
            }
        }

        // If this was the last extension client, notify all xfetch clients
        if (wasExtension && clients.extension.size === 0) {
            notifyXfetchClients(false);
        }

        stats.connectionStats.disconnections++;
        console.log(`Client ${ws.clientType} disconnected from ${clientIp} with ID ${clientId}`);
    });

    // If there are no extension clients, notify this client
    if (ws.clientType === 'xfetch' && clients.extension.size === 0) {
        sendToXfetch(ws, { type: 'extensionUnavailable' });
    }

    // Handle WebSocket errors
    ws.on('error', (err) => {
        console.log({
            type: 'error',
            from: 'WebSocket Error',
            message: err.message
        });
    });
});

/**
 * Graceful shutdown handler
 */
process.on('SIGINT', () => {
    console.log('Shutting down WebSocket server...');

    // Clear intervals
    clearInterval(heartbeatInterval);

    // Close all connections
    wss.clients.forEach((client) => {
        client.close();
    });

    // Close the server
    wss.close(() => {
        console.log('WebSocket server closed');
        process.exit(0);
    });
});