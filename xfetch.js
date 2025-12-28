const { EmitClient } = require('emit.gg/client');
const { v4: uuidv4 } = require('uuid');

class Xfetch {
    constructor(wsUrl, options = {}) {
        // Configuration with defaults
        this.config = {
            timeout: options.timeout || 30000,
            maxRetries: options.maxRetries || 3,
            reconnect: options.reconnect !== false, // Default to true
            reconnectDelay: options.reconnectDelay || 1000,
            maxReconnectAttempts: options.maxReconnectAttempts || 10,
        };

        this.cookies = new Map();
        this.wsUrl = wsUrl;
        this.socket = null;
        this.isConnected = false;
        this.extensionAvailable = false;
        this.isIdentified = false;
        this.pendingRequests = new Map();
        this.requestQueue = [];

        this._initSocket();
    }

    log(message, type = 'INFO', origin = 'Xfetch') {
        try {
            const colors = {
                ERROR: '\x1b[31m',
                WARN: '\x1b[33m',
                DEBUG: '\x1b[32m',
                INFO: '\x1b[34m',
            };
            const color = colors[type] || colors.INFO;
            console.log(`${color}[Xfetch-${type}]\x1b[0m ${message} - ${new Date().toISOString()} @${origin}`);
        } catch (err) {
            console.log(`\x1b[31m[Xfetch-ERROR]\x1b[0m Failed to log message: ${err.message}`);
        }
    }

    async _initSocket() {
        try {
            this.log('Connecting to WebSocket server...', 'INFO', '_initSocket');

            this.socket = await EmitClient.connect(this.wsUrl, {
                reconnect: this.config.reconnect,
                reconnectDelay: this.config.reconnectDelay,
                maxRetries: this.config.maxReconnectAttempts,
                connectTimeout: this.config.timeout,
            });

            this._setupEventHandlers();

            // Connection is established, set flags
            this.isConnected = true;
            this.log('WebSocket connection established', 'INFO', '_initSocket');

            // Server will send @identify event, we'll respond to that
        } catch (err) {
            this.log(`Failed to connect: ${err.message}`, 'ERROR', '_initSocket');
            throw err;
        }
    }

    _setupEventHandlers() {
        // Connection established
        this.socket.on('@connection', () => {
            this.log('Connected to server', 'INFO', '_setupEventHandlers');
            this.isConnected = true;
            this._identifyClient();
        });

        // Disconnection
        this.socket.on('@disconnect', () => {
            this.log('Disconnected from server', 'WARN', '_setupEventHandlers');
            this.isConnected = false;
            this.extensionAvailable = false;
            this.isIdentified = false;

            // Reject all pending requests
            for (const [id, pending] of this.pendingRequests.entries()) {
                if (pending.timeoutId) {
                    clearTimeout(pending.timeoutId);
                }
                pending.reject(new Error('WebSocket connection closed'));
                this.pendingRequests.delete(id);
            }
        });

        // Reconnection
        this.socket.on('@reconnect', () => {
            this.log('Reconnected to server', 'INFO', '_setupEventHandlers');
            this.isConnected = true;
            // Server will send @identify on new connection, we'll respond to that
            // Don't need to identify here as it would cause double identification
        });

        // Server requests identification
        this.socket.on('@identify', () => {
            this.log('Server requesting identification', 'DEBUG', '_setupEventHandlers');
            this._identifyClient();
        });

        // Identification confirmed
        this.socket.on('@identified', (data) => {
            this.log(`Identification confirmed: ${data.clientType}`, 'INFO', '_setupEventHandlers');
            this.isIdentified = true;
            this._processQueue();
        });

        // Extension availability status
        this.socket.on('@extension-status', (data) => {
            const wasAvailable = this.extensionAvailable;
            this.extensionAvailable = data.available;

            if (this.extensionAvailable && !wasAvailable) {
                this.log('Extension client now available, processing queue...', 'INFO', '_setupEventHandlers');
                this._processQueue();
            } else if (!this.extensionAvailable && wasAvailable) {
                this.log('Extension client no longer available, requests will be queued', 'WARN', '_setupEventHandlers');
            }
        });

        // Fetch response from extension
        this.socket.on('/fetch-response', (data) => {
            const { id, response, error } = data;

            if (!id || !this.pendingRequests.has(id)) {
                this.log(`Received response for unknown request: ${id}`, 'WARN', '_setupEventHandlers');
                return;
            }

            const pending = this.pendingRequests.get(id);

            // Clear timeout
            if (pending.timeoutId) {
                clearTimeout(pending.timeoutId);
            }

            // Store cookies if present
            if (response && response.cookies) {
                this.setCookies(response.url || pending.url, response.cookies);
            }

            // Resolve or reject the promise
            if (error) {
                this.log(`Request ${id} failed: ${error}`, 'ERROR', '_setupEventHandlers');
                pending.reject(new Error(error));
            } else {
                this.log(`Request ${id} succeeded`, 'DEBUG', '_setupEventHandlers');
                pending.resolve(response);
            }

            this.pendingRequests.delete(id);
        });

        // Error handling
        this.socket.on('@error', (data) => {
            this.log(`Server error: ${data.error || 'Unknown error'}`, 'ERROR', '_setupEventHandlers');
        });
    }

    _identifyClient() {
        if (!this.socket || !this.socket.connected) {
            this.log('Cannot identify: socket not connected', 'WARN', '_identifyClient');
            return;
        }

        this.log('Sending client identification...', 'DEBUG', '_identifyClient');
        this.socket.emit('/identify', { clientType: 'xfetch' });
    }

    _processQueue() {
        if (this.requestQueue.length === 0) {
            return;
        }

        const canProcess = this.isConnected && this.isIdentified && this.extensionAvailable;

        if (canProcess) {
            this.log(`Processing ${this.requestQueue.length} queued requests...`, 'INFO', '_processQueue');
            const queue = [...this.requestQueue];
            this.requestQueue = [];

            queue.forEach(({ url, options, resolve, reject }) => {
                this._sendRequest(url, options, resolve, reject);
            });
        } else {
            this.log(
                `Cannot process queue: connected=${this.isConnected}, identified=${this.isIdentified}, extensionAvailable=${this.extensionAvailable}`,
                'DEBUG',
                '_processQueue'
            );
        }
    }

    async fetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            if (this.isConnected && this.isIdentified && this.extensionAvailable) {
                this._sendRequest(url, options, resolve, reject);
            } else {
                this.log(`Connection not ready, queuing request for ${url}...`, 'WARN', 'fetch');
                this.requestQueue.push({ url, options, resolve, reject });

                // Set timeout for queued request
                const queueTimeout = setTimeout(() => {
                    const index = this.requestQueue.findIndex(
                        (req) => req.url === url && req.resolve === resolve && req.reject === reject
                    );

                    if (index !== -1) {
                        this.requestQueue.splice(index, 1);
                        this.log(`Timeout reached for queued request to ${url}`, 'WARN', 'fetch');

                        if (this.isConnected && !this.extensionAvailable) {
                            reject(new Error(`No extension client available after ${this.config.timeout}ms`));
                        } else if (!this.isConnected) {
                            reject(new Error(`Failed to establish WebSocket connection within ${this.config.timeout}ms`));
                        } else {
                            reject(new Error(`Request timeout after ${this.config.timeout}ms`));
                        }
                    }
                }, this.config.timeout);

                // Store timeout ID for cleanup
                this.requestQueue[this.requestQueue.length - 1].timeoutId = queueTimeout;
            }
        });
    }

    _sendRequest(url, options, resolve, reject) {
        const requestId = uuidv4();

        // Add cookies from cookie jar if requested
        if (options.cookiejar === true) {
            options.cookies = this.getCookies(url);
        }

        // Store promise callbacks
        this.pendingRequests.set(requestId, { resolve, reject, url, options });

        // Set up timeout handling
        const timeoutId = setTimeout(() => {
            if (this.pendingRequests.has(requestId)) {
                this.log(`Request ${requestId} timed out after ${this.config.timeout}ms`, 'WARN', '_sendRequest');
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request failed: timeout after ${this.config.timeout}ms`));
            }
        }, this.config.timeout);

        this.pendingRequests.get(requestId).timeoutId = timeoutId;

        // Send request
        try {
            this.log(`Sending fetch request ${requestId} to ${url}`, 'DEBUG', '_sendRequest');
            this.socket.emit('/fetch', { url, options, id: requestId });
        } catch (err) {
            this.log(`Error sending request ${requestId}: ${err.message}`, 'ERROR', '_sendRequest');
            clearTimeout(timeoutId);
            this.pendingRequests.delete(requestId);
            reject(new Error(`Failed to send request: ${err.message}`));
        }
    }

    getCookies(url) {
        const domain = new URL(url).hostname;
        return Array.from(this.cookies.get(domain) || []);
    }

    setCookies(url, cookies) {
        const domain = new URL(url).hostname;
        this.cookies.set(domain, cookies);
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            isIdentified: this.isIdentified,
            extensionAvailable: this.extensionAvailable,
            pendingRequests: this.pendingRequests.size,
            requestQueue: this.requestQueue.length,
        };
    }

    async close() {
        if (this.socket) {
            this.log('Closing WebSocket connection', 'INFO', 'close');

            // Reject all pending requests
            for (const [id, pending] of this.pendingRequests.entries()) {
                if (pending.timeoutId) {
                    clearTimeout(pending.timeoutId);
                }
                pending.reject(new Error('Client closed'));
            }

            this.pendingRequests.clear();
            this.requestQueue = [];

            this.socket.close();
            this.socket = null;
            this.isConnected = false;
            this.extensionAvailable = false;
            this.isIdentified = false;
        }
    }
}

module.exports = Xfetch;
