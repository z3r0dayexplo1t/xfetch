/**
 * XFetch Chrome Extension - Background Service Worker
 * Handles fetch request execution in browser context with proper tab management
 */

// Configuration
const CONFIG = {
    WORKER_URL: chrome.runtime.getURL('worker.html'),
    TAB_LOAD_TIMEOUT: 30000, // 30 seconds
    REQUEST_TIMEOUT: 60000,   // 60 seconds
    CLEANUP_INTERVAL: 60000,  // 1 minute
};

// State management
const state = {
    pendingRequests: new Map(),
    activeTabs: new Map(),
    tabListeners: new Map(),
    wsConnected: false,
};

/**
 * Open worker page when extension icon is clicked
 */
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: CONFIG.WORKER_URL });
});

/**
 * Main message handler
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message.action) {
        return;
    }

    switch (message.action) {
        case 'fetch_request':
            handleFetchRequest(message.payload);
            break;
        case 'ws_fetch_response':
            handleFetchResponse(message, sender);
            break;
        case 'ws_fetch_error':
            handleFetchError(message, sender);
            break;
        case 'ws_connection_status':
            state.wsConnected = message.connected;
            console.log(`[Background] WebSocket ${message.connected ? 'connected' : 'disconnected'}`);
            break;
    }

    // No need to return true - we're not using sendResponse callback
    // We send responses via chrome.runtime.sendMessage instead
});

/**
 * Handle incoming fetch request from worker
 */
function handleFetchRequest(payload) {
    if (!payload || !payload.id || !payload.url) {
        console.error('[Background] Invalid fetch request payload:', payload);
        return;
    }

    const { id, url, options } = payload;

    // Store request metadata
    state.pendingRequests.set(id, {
        id,
        url,
        timestamp: Date.now(),
        status: 'pending',
    });

    console.log(`[Background] Processing fetch request ${id} for ${url}`);

    // Execute fetch
    executeFetch(id, url, options || {});
}

/**
 * Execute fetch request by creating a hidden tab
 */
async function executeFetch(requestId, url, options) {
    try {
        const requestInfo = state.pendingRequests.get(requestId);
        if (!requestInfo) {
            console.warn(`[Background] Request ${requestId} no longer pending`);
            return;
        }

        requestInfo.status = 'executing';

        // Create hidden tab
        const tab = await chrome.tabs.create({ url, active: false });
        const tabId = tab.id;

        // Track active tab
        state.activeTabs.set(tabId, {
            id: tabId,
            requestId,
            createdAt: Date.now(),
            url: extractDomain(url),
        });

        console.log(`[Background] Created tab ${tabId} for request ${requestId}`);

        // Set up tab load timeout
        const loadTimeout = setTimeout(() => {
            console.warn(`[Background] Tab ${tabId} load timeout for request ${requestId}`);
            cleanupTab(tabId);
            sendError(requestId, 'Tab load timeout - page took too long to load');
        }, CONFIG.TAB_LOAD_TIMEOUT);

        // Set cookies if provided
        if (options.cookies) {
            try {
                await setCookies(url, options.cookies, options.path);
                console.log(`[Background] Cookies set for ${extractDomain(url)}`);
            } catch (err) {
                console.error(`[Background] Failed to set cookies:`, err);
                clearTimeout(loadTimeout);
                cleanupTab(tabId);
                sendError(requestId, `Failed to set cookies: ${err.message}`);
                return;
            }
        }

        // Execute script when tab is ready
        setupTabListener(tabId, requestId, url, options, loadTimeout);
    } catch (err) {
        console.error(`[Background] Error executing fetch:`, err);
        sendError(requestId, err.message);
    }
}

/**
 * Set up listener for tab load completion
 */
function setupTabListener(tabId, requestId, url, options, loadTimeout) {
    const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId) return;

        if (changeInfo.status === 'complete') {
            clearTimeout(loadTimeout);
            removeTabListener(tabId);

            // Execute fetch script in tab context
            executeScriptInTab(tabId, requestId, url, options);
        }
    };

    state.tabListeners.set(tabId, listener);
    chrome.tabs.onUpdated.addListener(listener);
}

/**
 * Remove tab update listener
 */
function removeTabListener(tabId) {
    const listener = state.tabListeners.get(tabId);
    if (listener) {
        chrome.tabs.onUpdated.removeListener(listener);
        state.tabListeners.delete(tabId);
    }
}

/**
 * Execute fetch script in tab context
 */
async function executeScriptInTab(tabId, requestId, url, options) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: performFetch,
            args: [requestId, url, options],
        });
    } catch (err) {
        console.error(`[Background] Script execution failed for request ${requestId}:`, err);
        cleanupTab(tabId);
        sendError(requestId, `Script execution failed: ${err.message}`);
    }
}

/**
 * Function injected into tab to perform actual fetch
 * This runs in the page context, not the extension context
 */
async function performFetch(requestId, url, options) {
    try {
        const response = await fetch(url, options);

        // Serialize response
        const serializedResponse = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries([...response.headers.entries()]),
            body: await response.text(),
            url: response.url,
            type: response.type,
            redirected: response.redirected,
            bodyUsed: response.bodyUsed,
        };

        chrome.runtime.sendMessage({
            action: 'ws_fetch_response',
            id: requestId,
            response: serializedResponse,
            url: response.url,
        });
    } catch (err) {
        chrome.runtime.sendMessage({
            action: 'ws_fetch_error',
            id: requestId,
            error: err.message,
        });
    }
}

/**
 * Handle fetch response from tab
 */
async function handleFetchResponse(message, sender) {
    const requestId = message.id;
    const requestInfo = state.pendingRequests.get(requestId);

    if (!requestInfo) {
        console.warn(`[Background] Received response for unknown request ${requestId}`);
        return;
    }

    const tabId = sender.tab?.id;

    try {
        // Get cookies for the domain
        let cookies = [];
        if (message.url) {
            cookies = await getCookiesForDomain(message.url);
        }

        // Send response to worker
        await chrome.runtime.sendMessage({
            action: 'fetch_response',
            id: requestId,
            payload: {
                ...message.response,
                cookies,
            },
        });

        console.log(`[Background] Request ${requestId} completed successfully`);
    } catch (err) {
        console.error(`[Background] Error handling response for ${requestId}:`, err);
    } finally {
        // Cleanup
        if (tabId) {
            cleanupTab(tabId);
        }
        state.pendingRequests.delete(requestId);
    }
}

/**
 * Handle fetch error from tab
 */
async function handleFetchError(message, sender) {
    const requestId = message.id;
    const requestInfo = state.pendingRequests.get(requestId);

    if (!requestInfo) {
        console.warn(`[Background] Received error for unknown request ${requestId}`);
        return;
    }

    const tabId = sender.tab?.id;

    try {
        await chrome.runtime.sendMessage({
            action: 'fetch_response',
            id: requestId,
            error: message.error,
        });

        console.log(`[Background] Request ${requestId} failed: ${message.error}`);
    } catch (err) {
        console.error(`[Background] Error handling error for ${requestId}:`, err);
    } finally {
        // Cleanup
        if (tabId) {
            cleanupTab(tabId);
        }
        state.pendingRequests.delete(requestId);
    }
}

/**
 * Set cookies for a URL
 */
async function setCookies(url, cookies, path = '/') {
    const domain = extractDomain(url);
    const cookiePromises = [];

    if (typeof cookies === 'string') {
        // Parse cookie string "name=value; name2=value2"
        const cookiePairs = cookies.split(';');
        for (const pair of cookiePairs) {
            const [name, value] = pair.split('=');
            if (name && value) {
                cookiePromises.push(
                    chrome.cookies.set({
                        url,
                        name: name.trim(),
                        value: value.trim(),
                        path,
                        domain,
                        sameSite: 'none',
                        secure: url.startsWith('https'),
                    })
                );
            }
        }
    } else if (Array.isArray(cookies)) {
        // Array of cookie objects
        for (const cookie of cookies) {
            cookiePromises.push(
                chrome.cookies.set({
                    url,
                    name: cookie.name,
                    value: cookie.value,
                    path,
                    domain,
                    sameSite: 'none',
                    secure: url.startsWith('https'),
                })
            );
        }
    } else if (typeof cookies === 'object') {
        // Object with name: value pairs
        for (const [name, value] of Object.entries(cookies)) {
            cookiePromises.push(
                chrome.cookies.set({
                    url,
                    name,
                    value,
                    path,
                    domain,
                    sameSite: 'none',
                    secure: url.startsWith('https'),
                })
            );
        }
    }

    await Promise.all(cookiePromises);
}

/**
 * Get all cookies for a domain and its subdomains
 */
async function getCookiesForDomain(url) {
    const domain = extractDomain(url);
    const allCookies = await chrome.cookies.getAll({});

    // Filter cookies for the domain and its subdomains
    return allCookies.filter((cookie) => {
        const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        return domain.endsWith(cookieDomain) || cookieDomain.endsWith(domain);
    });
}

/**
 * Send error response to worker
 */
async function sendError(requestId, errorMessage) {
    try {
        await chrome.runtime.sendMessage({
            action: 'fetch_response',
            id: requestId,
            error: errorMessage,
        });
    } catch (err) {
        console.error(`[Background] Failed to send error for ${requestId}:`, err);
    } finally {
        state.pendingRequests.delete(requestId);
    }
}

/**
 * Clean up tab and associated state
 */
function cleanupTab(tabId) {
    if (!tabId) return;

    // Remove listener
    removeTabListener(tabId);

    // Close tab
    chrome.tabs.remove(tabId).catch((err) => {
        console.warn(`[Background] Failed to close tab ${tabId}:`, err.message);
    });

    // Remove from active tabs
    state.activeTabs.delete(tabId);

    console.log(`[Background] Cleaned up tab ${tabId}`);
}

/**
 * Extract domain from URL safely
 */
function extractDomain(url) {
    try {
        return new URL(url).hostname;
    } catch (err) {
        console.error(`[Background] Invalid URL: ${url}`);
        return '';
    }
}

/**
 * Periodic cleanup of stale requests and zombie tabs
 */
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    // Clean up stale pending requests (older than REQUEST_TIMEOUT)
    for (const [id, request] of state.pendingRequests.entries()) {
        if (now - request.timestamp > CONFIG.REQUEST_TIMEOUT) {
            console.warn(`[Background] Cleaning up stale request ${id}`);
            sendError(id, 'Request timeout - exceeded maximum processing time');
            cleaned++;
        }
    }

    // Clean up zombie tabs (older than TAB_LOAD_TIMEOUT)
    for (const [tabId, tab] of state.activeTabs.entries()) {
        if (now - tab.createdAt > CONFIG.TAB_LOAD_TIMEOUT) {
            console.warn(`[Background] Cleaning up zombie tab ${tabId} for request ${tab.requestId}`);
            cleanupTab(tabId);
            sendError(tab.requestId, 'Tab became unresponsive');
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[Background] Cleanup completed: ${cleaned} items cleaned`);
    }
}, CONFIG.CLEANUP_INTERVAL);

// Log extension initialization
console.log('[Background] XFetch background service worker initialized');
console.log('[Background] Configuration:', CONFIG);
