/**
 * XFetch Chrome Extension Worker
 * Handles WebSocket communication with emit.gg and executes fetch requests
 */

const WS_SERVER = 'ws://localhost:3006';

let socket = null;
let isConnected = false;
let isIdentified = false;

/**
 * Initialize WebSocket connection using emit.gg
 */
async function initWebSocket() {
    try {
        console.log('[Worker] Connecting to WebSocket server...');

        socket = await EmitClient.connect(WS_SERVER, {
            reconnect: true,
            reconnectDelay: 2000,
            maxRetries: 10,
            connectTimeout: 10000,
        });

        setupEventHandlers();
        console.log('[Worker] WebSocket connection established');
    } catch (err) {
        console.error('[Worker] Failed to connect:', err.message);
        setTimeout(initWebSocket, 5000);
    }
}

/**
 * Setup event handlers for WebSocket
 */
function setupEventHandlers() {
    // Connection established
    socket.on('@connection', () => {
        console.log('[Worker] Connected to server');
        isConnected = true;

        // Notify background script
        notifyBackground('connected', true);
    });

    // Disconnection
    socket.on('@disconnect', () => {
        console.log('[Worker] Disconnected from server');
        isConnected = false;
        isIdentified = false;

        // Notify background script
        notifyBackground('disconnected', false);
    });

    // Reconnection
    socket.on('@reconnect', () => {
        console.log('[Worker] Reconnected to server');
        isConnected = true;
        identifyClient();
    });

    // Server requests identification
    socket.on('@identify', () => {
        console.log('[Worker] Server requesting identification');
        identifyClient();
    });

    // Identification confirmed
    socket.on('@identified', (data) => {
        console.log('[Worker] Identification confirmed:', data.clientType);
        isIdentified = true;
    });

    // Fetch request from server
    socket.on('/fetch-request', (data) => {
        console.log('[Worker] Received fetch request:', data);
        handleFetchRequest(data);
    });

    // Error handling
    socket.on('@error', (data) => {
        console.error('[Worker] Server error:', data.error || 'Unknown error');
    });
}

/**
 * Identify this client as an extension
 */
function identifyClient() {
    if (!socket || !socket.connected) {
        console.warn('[Worker] Cannot identify: socket not connected');
        return;
    }

    console.log('[Worker] Sending client identification...');
    socket.emit('/identify', { clientType: 'extension' });
}

/**
 * Handle fetch request from server
 */
function handleFetchRequest(data) {
    const { id, url, options } = data;

    if (!id || !url) {
        console.error('[Worker] Invalid fetch request: missing id or url');
        return;
    }

    console.log(`[Worker] Processing fetch request ${id} for ${url}`);

    // Send to background script for execution
    chrome.runtime.sendMessage({
        action: 'fetch_request',
        payload: { id, url, options }
    });
}

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetch_response') {
        handleFetchResponse(message);
    }
    return true;
});

/**
 * Handle fetch response from background script
 */
function handleFetchResponse(message) {
    const { id, payload, error } = message;

    if (!socket || !socket.connected) {
        console.error('[Worker] Cannot send response: socket not connected');
        return;
    }

    console.log(`[Worker] Sending response for request ${id}`);

    // Send response to server
    socket.emit('/response', {
        id,
        response: payload,
        error: error
    });
}

/**
 * Notify background script of connection status
 */
function notifyBackground(status, connected) {
    try {
        chrome.runtime.sendMessage({
            action: 'ws_connection_status',
            status,
            connected
        });
    } catch (err) {
        console.error('[Worker] Failed to notify background:', err.message);
    }
}

// Initialize WebSocket connection when script loads
initWebSocket();

console.log('[Worker] XFetch worker initialized');
