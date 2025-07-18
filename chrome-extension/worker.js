const WS_SERVER = 'ws://localhost:3006'
const HEARTBEAT_CONFIG = {
    maxMissedHeartbeats: 3,
    reconnectDelay: 5000,
    maxReconnectAttempts: 10,
    exponentialBackoff: true,
}

const connectionMetrics = {
    connectionsTotal: 0,
    reconnections: 0,
    disconnections: 0,
    lastConnectedAt: null,
    uptime: 0,
    latency: 0,
    requestsProcessed: 0
}


let ws = null
let isConnected = false
let reconnectAttempts = 0
let reconnectTimer = null
let lastPingReceived = null
let missedHeartbeats = 0
let connectionStatus = 'disconnected'
let clientId = Math.round(Date.now() / 1000)


function initWebSocket() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }

    if (ws) {
        ws.close()
    }


    try {
        ws = new WebSocket(WS_SERVER)
        ws.addEventListener("open", handleWebSocketOpen)
        ws.addEventListener('message', handleWebSocketMessage)
        ws.addEventListener('close', handleWebSocketClose)
        ws.addEventListener('error', handleWebSocketError)



    } catch (err) {
        console.log({
            type: 'error',
            from: 'InitWebSocket',
            message: err.message
        });
    }

}



function updateConnectionStatus(newStatus) {
    if (connectionStatus !== newStatus) {
        connectionStatus = newStatus

        chrome.runtime.sendMessage({
            action: 'ws_connection_status',
            status: newStatus,
            connected: newStatus === 'connected'
        }).catch(err => {
            // Ignore messaging errors
        })
    }
}



function handleWebSocketOpen(event) {
    isConnected = true
    reconnectAttempts = 0
    missedHeartbeats = 0
    lastPingReceived = Date.now()
    connectionMetrics.lastConnectedAt = Date.now()
    connectionMetrics.connectionsTotal++

    chrome.runtime.sendMessage({
        action: 'ws_connection_status',
        status: 'connected',
        connected: true
    }).catch(err => {
        // ignore
    })


    console.log(`WebSocket connection established (clientId: ${clientId})`)


    updateConnectionStatus('connected')


}

function handleWebSocketMessage(event) {
    try {
        console.log(`Received WebSocket message: ${event.data}`);
        const message = JSON.parse(event.data);
        console.log('Parsed message type:', message.type);

        switch (message.type) {
            case 'identify':
                sendClientIdentification();
                break;

            case 'ping':
                handleHeartbeat(message);
                break;
            default:
                if (message.url && message.options && message.id !== undefined) {
                    connectionMetrics.requestsProcessed++;
                    processFetchRequest(message);
                } else {
                    console.log('Received unknown message format:', message);
                }
                break;
        }
    } catch (err) {
        console.log({
            type: 'error',
            from: 'handleWebSocketMessage',
            message: err.message,
            data: event.data
        });
    }
}


function sendPong(timestamp) {
    if (isConnected && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({
                type: 'pong',
                clientId: clientId,
                timestamp: timestamp,
                responseTimestamp: Date.now(),
                metrics: {
                    requestsProcessed: connectionMetrics.requestsProcessed,
                    uptime: Date.now() - connectionMetrics.lastConnectedAt
                }

            }))
        } catch (err) {
            console.log({
                type: 'error',
                from: 'sendPong',
                message: err.message
            })

            // If we can't send a pong, the connection might be degraded
            updateConnectionStatus('degraded')
        }
    }
}



function handleHeartbeat(message) {
    console.log('Received heartbeat ping from server');
    
    if (message.timestamp) {
        const latency = Date.now() - message.timestamp;
        connectionMetrics.latency = latency;
        console.log(`Calculated latency: ${latency}ms`);
    }

    lastPingReceived = Date.now();
    missedHeartbeats = 0;
    console.log('Reset missed heartbeats counter to 0');

    sendPong(message.timestamp);
    
    if (connectionStatus === 'degraded') {
        console.log('Recovering from degraded status...');
        updateConnectionStatus('connected');
    }
}




function handleWebSocketClose(event) {
    isConnected = false
    updateConnectionStatus('disconnected')
    connectionMetrics.disconnections++

    chrome.runtime.sendMessage({
        action: 'ws_connection_status',
        status: 'disconnected',
        connected: false
    }).catch(err => {
        //ignore
    })

    console.log('WebSocket connection closed')
    scheduleReconnect()
}

function handleWebSocketError(event) {
    console.log({
        type: 'error',
        from: 'WebSocketError',
        message: 'WebSocket connection error'
    })

    updateConnectionStatus('degraded')
}





function scheduleReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }

    reconnectAttempts++

    let delay = HEARTBEAT_CONFIG.reconnectDelay;
    if (HEARTBEAT_CONFIG.exponentialBackoff) {
        delay = Math.min(30000, delay * Math.pow(1.5, Math.min(reconnectAttempts - 1, 10)))
    }

    if (HEARTBEAT_CONFIG.maxReconnectAttempts === 0 || reconnectAttempts <= HEARTBEAT_CONFIG.maxReconnectAttempts) {
        console.log(`Scheduling reconnection attempt ${reconnectAttempts} in ${delay}ms`)
        reconnectTimer = setTimeout(() => {
            connectionMetrics.reconnections++
            initWebSocket()
        }, delay)
    } else {
        console.log(`Maximum reconnection attempts (${HEARTBEAT_CONFIG.maxReconnectAttempts}) reached. Giving up.`)
        updateConnectionStatus('failed')
    }

}

function sendClientIdentification() {
    if (isConnected && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({
                type: 'identify',
                clientType: 'extension',
                clientId: clientId,
                extensionVersion: chrome.runtime.getManifest().version,
                capabilities: {
                    concurrency: 5,
                    platforms: ['instagram', 'twitter', 'tiktok', 'reddit']
                }
            }))
            console.log('Sent client identification')
        } catch (err) {
            console.log({
                type: 'error',
                from: 'sendClientIdentification',
                message: err.message
            })
        }
    }
}





function processFetchRequest(message) {
    if (isConnected && ws.readyState === WebSocket.OPEN) {
        chrome.runtime.sendMessage({
            action: 'fetch_request', 
            payload: message, 
            id: message.id
        }).catch(err => {
             if(isConnected && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        id: message.id, 
                        error: `Failed to process request: ${err.message}`
                    }))
                } catch (wsErr) {
                    console.log({
                        type: 'error', 
                        from: 'processFetchRequest', 
                        
                    })
                }
             }
            
        })
    }
}


setInterval(() => {
    if(isConnected && lastPingReceived) {
        const timeSinceLastPing = Date.now() - lastPingReceived; 
        console.log(`Time since last ping: ${timeSinceLastPing}ms, Reconnect delay: ${HEARTBEAT_CONFIG.reconnectDelay}ms`);
        
        if(timeSinceLastPing > HEARTBEAT_CONFIG.reconnectDelay) {
            missedHeartbeats++; 
            console.log(`Incrementing missed heartbeats to ${missedHeartbeats}/${HEARTBEAT_CONFIG.maxMissedHeartbeats}`);
            
            if(missedHeartbeats >= HEARTBEAT_CONFIG.maxMissedHeartbeats) {
                console.log(`Missed ${missedHeartbeats} heartbeats. Connection appears to be dead.`);
                ws.close();
                scheduleReconnect();
            } else {
                console.log(`Missed ${missedHeartbeats} heartbeats. Marking connection as degraded.`);
                updateConnectionStatus('degraded');
            }
        } else {
            // Reset missed heartbeats counter if we've received a ping in time
            if (missedHeartbeats > 0) {
                console.log(`Resetting missed heartbeats from ${missedHeartbeats} to 0`);
                missedHeartbeats = 0;
                if (connectionStatus === 'degraded') {
                    updateConnectionStatus('connected');
                }
            }
        }
    }
}, HEARTBEAT_CONFIG.reconnectDelay / 2);






chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.action === 'fetch_response' && message.id !== undefined) {
        if (isConnected && ws.readyState === WebSocket.OPEN) {
            try {
                console.log(message.payload)
                ws.send(JSON.stringify({
                    id: message.id,
                    response: message.payload,
                    error: message.error
                }))
                sendResponse({ success: true })
            } catch (err) {
                sendResponse({ success: false, error: err.message })
            }
        }
    }
    return true
})

initWebSocket()