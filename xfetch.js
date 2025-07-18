const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');



class Xfetch {
    constructor(wsUrl, options = {}) {

        //configuration with defaults
        this.config = {
            timeout: options.timeout || 5000,
            maxRetries: options.maxRetries || 3,
            heartbeatInterval: options.heartbeatInterval || 15000,
            queueCheckInterval: options.queueCheckInterval || 1000
        }

        this.cookies = new Map()
        this.wsUrl = wsUrl;
        this.ws = new WebSocket(wsUrl)
        this.isConnected = false;
        this.extensionAvailable = false;
        this.isIdentified = false;
        this.pendingRequests = new Object();
        this.requestQueue = new Array()
        this._giveUpTimers = new Array();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = this.config.maxRetries;
        this.reconnectDelay = this.config.timeout;
        

        this.setupWebSocket();
        this.heartBeatTimer = setInterval(() => this.sendHeartbeat(), this.config.heartbeatInterval);
        this.queueCheckTimer = setInterval(() => this.processQueue(), this.config.queueCheckInterval);


    }

    log(message, type = 'INFO', origin = 'Xfetch') {
        try {

            type === 'ERROR' ? console.log(`\x1b[31m[Xfetch-${type}]\x1b[0m ${message} - ${new Date().toISOString()} @${origin}`) :
                type === 'WARN' ? console.log(`\x1b[33m[Xfetch-${type}]\x1b[0m ${message} - ${new Date().toISOString()} @${origin}`) :
                    type === 'DEBUG' ? console.log(`\x1b[32m[Xfetch-${type}]\x1b[0m ${message} - ${new Date().toISOString()} @${origin}`) :
                        console.log(`\x1b[34m[Xfetch-${type}]\x1b[0m ${message} - ${new Date().toISOString()} @${origin}`);

        } catch (err) {

            console.log(`\x1b[31m[Xfetch-ERROR]\x1b[0m Failed to log message: ${err.message}`);
        }



    }


    setupWebSocket() {
        //handle incoming websocket messages 
        this.ws.onmessage = ((event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'ping') {
                    this.sendPong();
                    return
                } else if (data.type === 'extensionAvailable') {
                    this.log(`Extension client now available, processing queue...`, null, 'setupWebSocket');
                    this.extensionAvailable = true;
                    this.processQueue();
                    return
                } else if (data.type === 'extensionUnavailable') {
                    this.log(`Extension client no longer available, requests will be queued`, 'WARN', 'setupWebSocket');
                    this.extensionAvailable = false;
                    return
                } else if (data.type === 'identified') {
                    this.isIdentified = true; 
                    this.log('Received identification confirmation', 'INFO', 'setupWebSocket'); 
                    this.isIdentifiedTimer ? clearInterval(this.isIdentifiedTimer) : null; 
                    return; 
                }

                // handle response messages 

                const { id, response, error } = data;
                if (id !== undefined && this.pendingRequests[id]) {
                    //clear timeout for this request
                    if (this.pendingRequests[id].timeoutId) {
                        clearTimeout(this.pendingRequests[id].timeoutId)
                    }

                    error
                        ? this.pendingRequests[id].reject(error)
                        : this.pendingRequests[id].resolve(response)

                   response.cookies && this.setCookies(response.url, [...response.cookies.map((cookie) => ({name: cookie.name, value: cookie.value}))])


                    delete this.pendingRequests[id];
                }

            } catch (err) {
                this.log(`Error handling message: ${err.message}`, 'ERROR', 'setupWebSocket');
            }
        })




        // Handle connection events 
        this.ws.onopen = () => {
            this.log('WebSocket connection established', 'INFO', 'setupWebSocket');
            this.isConnected = true;
            this.reconnectAttempts = 0;

            //clear give up timers
            if (this._giveUpTimers) {
                this._giveUpTimers.forEach(timer => clearTimeout(timer));
                this._giveUpTimers = new Array();
            }


            this.sendClientIdentification();
            this.processQueue();

        }


        this.ws.onclose = () => {
            this.log('WebSocket connection closed', 'WARN', 'setupWebSocket');
            this.isConnected = false;
            this.extensionAvailable = false;

            //Reject any pending requests
            Object.keys(this.pendingRequests).forEach((id) => {
                if (this.pendingRequests[id].timeoutId) {
                    clearTimeout(this.pendingRequests[id].timeoutId);
                }
                this.pendingRequests[id].reject(new Error('WebSocket connection closed'));
                delete this.pendingRequests[id];
            })


            //Attempt to reconnect with exponential backoff
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
                setTimeout(() => this.reconnect(), delay);
            }


            this.ws.onerror = (error) => {
                this.log(`WebSocket error: ${error.message}`, 'ERROR', 'setupWebSocket');
            }
        }


    }


    processQueue() {
        if(this.requestQueue.length === 0){
            return;
        }

        const canProcess = this.requestQueue.length > 0 &&
            this.isConnected &&
            this.ws.readyState === WebSocket.OPEN &&
            this.extensionAvailable;

        if (canProcess) {
            console.log(`Processing ${this.requestQueue.length} queued requests...`, 'INFO', 'processQueue');
            const queue = [...this.requestQueue]
            this.requestQueue = [];


            //clear any give up timers
            if (this._giveUpTimers.length > 0) {
                this._giveUpTimers.forEach(timer => clearTimeout(timer));
                this._giveUpTimers = []
            }

            // process queue items
            queue.forEach(({ url, options, resolve, reject, retryCount }) => {
                this._sendRequest(url, options, resolve, reject, retryCount)
            })
        } else if (this.requestQueue.length > 0) {
            this.log(`(${this.requestQueue.length}) queued requests: connected=${this.isConnected}, readyState=${this.ws.readyState}, extensionAvailable=${this.extensionAvailable}`, 'WARN', 'processQueue');
        }
    }


    fetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            if (this.isConnected && this.ws.readyState === WebSocket.OPEN && this.extensionAvailable && this.isIdentified) {
                //if all systems give green light, send request immediately
                this._sendRequest(url, options, resolve, reject, 0);
            } else {
                this.log(`Connection not ready, queuing request for ${url}...`, 'WARN', 'fetch');


                // add request to queue 
                this.requestQueue.push({ url, options, resolve, reject, retryCount: 0 })

                //reconnect if needed
                if (!this.isConnected && this.ws.readyState !== WebSocket.CONNECTING) {
                    this.reconnect();
                }

                if(!this.isIdentified){
                    this.log(`Not identified, queuing request for ${url}...`, 'WARN', 'fetch');
                    this.isIdentifiedTimer = setInterval((resolve, reject, counter = 0) => {
                        if(counter >= 3){
                            this.log(`Failed to identify with server, rejecting promise`, 'ERROR', 'fetch');
                            reject(new Error('Failed to identify with server'));
                        }else{
                            this.sendClientIdentification(resolve, reject, counter + 1);
                            
                        }
                    }, this.config.timeout);
                }

                // set timeout to reject if request isnt processed within timeout period 
                const giveUpTimer = setTimeout(() => {

                    const index = this.requestQueue.findIndex(req =>
                        req.url === url &&
                        req.resolve === resolve &&
                        req.reject === reject
                    )

                    if (index !== -1) {
                        this.requestQueue.splice(index, 1);

                        this.log(`Timeout reached for request to ${url}, removing from queue and rejecting promise`, 'WARN', 'fetch');

                        if (this.isConnected && !this.extensionAvailable) {
                            reject(new Error(`No extension client available after ${this.config.timeout}ms`))
                        } else if (!this.isConnected) {
                            reject(new Error(`Failed to establish WebSocket connection within ${this.config.timeout}ms`))
                        } else {
                            reject(new Error(`Request timeout after ${this.config.timeout}ms`))
                        }

                    }

                }, this.config.timeout)

                this._giveUpTimers.push(giveUpTimer)
            }
        })
    }


    getCookies(url){
        const domain = new URL(url).hostname;
        return Array.from(this.cookies.get(domain) || [])
    }

    setCookies(url, cookies){
        const domain = new URL(url).hostname;
        this.cookies.set(domain, {...cookies})
    }


    _sendRequest(url, options, resolve, reject, retryCount) {
        const requestId = uuidv4()

        // store promise callbacks 
        this.pendingRequests[requestId] = { resolve, reject }

        //set up timeout handling for this requests
        const timeoutId = setTimeout(() => {
            if (this.pendingRequests[requestId]) {
                this.log(`Request ${requestId} timed out after ${this.config.timeout}ms`, 'WARN', '_sendRequest');
                delete this.pendingRequests[requestId]
            }


            if (retryCount < this.config.maxRetries) {
                this.log(`Request timed out, retrying (${retryCount + 1}/${this.config.maxRetries})...`, 'WARN', '_sendRequest');
                this._sendRequest(url, options, resolve, reject, retryCount + 1)

            } else {
                this.log(`Max retries (${this.config.maxRetries}) reached, rejecting promise`, 'ERROR', '_sendRequest');
                reject(new Error(`Request failed after ${this.config.maxRetries} retries`))
            }
        }, this.config.timeout)

        this.pendingRequests[requestId].timeoutId = timeoutId;

        //send request 
        options.cookiejar === true ? options.cookies = this.getCookies(url) : 
        options.cookies ? options.cookies : null;

        const message = JSON.stringify({ url, options, id: requestId })

        try {
            this.log(`Sending request ${requestId} to WebSocket server...`, 'DEBUG', '_sendRequest');
            this.ws.send(message)
        } catch (err) {

            this.log(`Error sending request ${requestId}: ${err.message}`, 'ERROR', '_sendRequest');
            clearTimeout(timeoutId)

            if (retryCount < this.config.maxRetries) {

                this.log(`Send failed, retrying (${retryCount + 1}/${this.config.maxRetries})...`, 'WARN', '_sendRequest');
                setTimeout(() => this._sendRequest(url, options, resolve, reject, retryCount + 1), 1000)

            } else {

                this.log(`Max retries (${this.config.maxRetries}) reached, rejecting promise`, 'ERROR', '_sendRequest');
                reject(new Error(`Failed to send request after ${this.config.maxRetries} retries: ${err.message}`))

            }
        }


    }



    reconnect() {
        this.log('Attempting to reconnect...', 'INFO', 'reconnect');
        try { this.ws.close() } catch (err) {//ignore}

            this.ws = new WebSocket(this.wsUrl);
            this.setupWebSocket();
        }
    }


    getStatus() {
        return {
            isConnected: this.isConnected,
            extensionAvailable: this.extensionAvailable,
            pendingRequests: Object.keys(this.pendingRequests).length,
            requestQueue: this.requestQueue.length,
            reconnectAttempts: this.reconnectAttempts
        }
    }

    sendClientIdentification() {
        try {
            const message = JSON.stringify({
                type: 'identify',
                clientType: 'xfetch'
            });

            this.ws.send(message);
            this.log('Submitted client identification', 'INFO', 'sendClientIdentification');
        } catch (err) {
            this.isIdentifiedTimer ? clearInterval(this.isIdentifiedTimer) : null;
            this.isIdentifiedTimer = setInterval(() => {
                this.log('Failed to identify with server, retrying...', 'ERROR', 'sendClientIdentification');
                this.sendClientIdentification();
            }, 1000);

            this.log({ type: 'error', from: 'sendClientIdentification', message: err.message }, 'ERROR', 'sendClientIdentification');
        }
    }

    sendHeartbeat() {
        if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
            try {

        

                const message = JSON.stringify({ type: 'ping' });
                this.ws.send(message);
                this.log('Sent heartbeat', 'DEBUG', 'sendHeartbeat');
            } catch (error) {
                this.log({ type: 'error', from: 'sendHeartbeat', message: error.message }, 'ERROR', 'sendHeartbeat');
            }
        }
    }

    sendPong() {
        if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
            try {
                const message = JSON.stringify({ type: 'pong' });
                this.ws.send(message);
                this.log('Sent pong', 'DEBUG', 'sendPong');
            } catch (error) {
                this.log({ type: 'error', from: 'sendPong', message: error.message }, 'ERROR', 'sendPong');
            }
        }
    }

    close() {
        if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {

            //clear timers
            if (this.heartBeatTimer) {
                clearInterval(this.heartBeatTimer);
            }

            if (this.queueCheckTimer) {
                clearInterval(this.queueCheckTimer);
            }

            try {
                this.ws.close();
                this.log('WebSocket connection closed', 'INFO', 'close');
            } catch (error) {
                this.log({ type: 'error', from: 'close', message: error.message }, 'ERROR', 'close');
            }
        }
    }
}


module.exports = Xfetch; 
