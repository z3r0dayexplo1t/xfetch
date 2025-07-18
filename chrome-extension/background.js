const pendingRequests = new Map()
const activeTabs = new Map()


const WORKER_URL = chrome.runtime.getURL('worker.html')
let wsConnected = false


chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({
        url: WORKER_URL
    })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetch_request' && message.payload) {
        const payload = message.payload
        pendingRequests.set(payload.id, {
            id: payload.id,
            timestamp: Date.now(),
            retries: 0,
            status: 'pending',
            fromWebSocket: true
        })

        executeFetch(payload)
    }
})

function executeFetch(payload) {
    const { url, options, id } = payload
    try {
        if (!pendingRequests.has(id)) {
            return
        }

        const requestInfo = pendingRequests.get(id)
        requestInfo.status = 'executing'

        try {
            chrome.tabs.create({ url: url, active: false }, (tab) => {
                const tabId = tab.id

                activeTabs.set(tabId, {
                    id: tab.id,
                    requestId: id,
                    createdAt: Date.now(),
                    url: url.split('https://')[1].split('/')[0]
                })

                if (options.cookies) {
                    const setCookiePromises = new Array()
                    const domain = new URL(url).hostname

                    if (typeof options.cookies === 'string') {
                        const cookiePairs = options.cookies.split(';');
                        for (const pair of cookiePairs) {
                            const [name, value] = pair.split('=');
                            if (name && value) {
                                setCookiePromises.push(chrome.cookies.set({
                                    url: url.split('https://')[1].split('/')[0],
                                    name: name.trim(),
                                    value: value.trim(),
                                    path: options.path || '/',
                                    domain: domain,
                                    sameSite: 'none'
                                }))
                            }
                        }
                    } else if (Array.isArray(options.cookies)) {
                        for (const cookie of options.cookies) {
                            setCookiePromises.push(chrome.cookies.set({
                                url: url.split('https://')[1].split('/')[0],
                                name: cookie.name,
                                value: cookie.value,
                                path: options.path || '/',
                                domain: domain,
                                sameSite: 'none'
                            }))
                        }
                    } else if (typeof options.cookies === 'object') {
                        for (const [name, value] of Object.entries(options.cookies)) {
                            setCookiePromises.push(chrome.cookies.set({
                                url: url.split('https://')[1].split('/')[0],
                                name: name,
                                value: value,
                                path: options.path || '/',
                                domain: domain,
                                sameSite: 'none'
                            }))
                        }
                    }

                    Promise.all(setCookiePromises)
                        .then(() => {
                            executeScript(tabId, url, options, id);
                        })
                        .catch((err) => {
                            chrome.runtime.sendMessage({
                                action: 'ws_fetch_error',
                                id: id,
                                error: `Failed to set cookies: ${err.message}`
                            });
                        });
                } else {
                    executeScript(tabId, url, options, id);
                }
            });
        } catch(err) {
            chrome.runtime.sendMessage({
                action: 'ws_fetch_error',
                id: id,
                error: err.message
            });
        }
    } catch(err) {
        chrome.runtime.sendMessage({
            action: 'ws_fetch_error',
            id: id,
            error: err.message
        });
    }
}

function executeScript(tabId, url, options, id) {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener)

            chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: async (id, url, options) => {
                    try {
                        const response = await fetch(url, options)
                        const serializedResponse = {
                            ok: response.ok,
                            status: response.status,
                            statusText: response.statusText,
                            headers: Object.fromEntries([...response.headers.entries()]),
                            body: await response.text(),
                            url: response.url,
                            type: response.type,
                            redirected: response.redirected,
                            bodyUsed: response.bodyUsed
                        }

                        chrome.runtime.sendMessage({
                            action: 'ws_fetch_response',
                            id: id,
                            response: serializedResponse,
                            url: url
                        })
                    } catch (err) {
                        chrome.runtime.sendMessage({
                            action: 'ws_fetch_error',
                            id: id,
                            error: err.message
                        })
                    }
                },
                args: [id, url, options]
            }).catch((err) => {
                chrome.runtime.sendMessage({
                    action: 'ws_fetch_error',
                    id: id,
                    error: err.message
                })
            })
        }
    })
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message.action) {
        return;
    }

    const tabId = sender.tab?.id
    const requestId = message.id
    const requestInfo = pendingRequests.get(requestId)

    if (!requestInfo) {
        return
    }

    if (message.action === "ws_fetch_response") {
        console.log('ws_fetch_response', message)
        
        const domain = message.url ? new URL(message.url).hostname : null;
        if (domain) {
            // Get all cookies for the domain and its subdomains
            chrome.cookies.getAll({}, (allCookies) => {
                // Filter cookies for the domain and its subdomains
                const relevantCookies = allCookies.filter(cookie => {
                    const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
                    return domain.endsWith(cookieDomain);
                });

                if (tabId && activeTabs.has(tabId)) {
                    chrome.tabs.remove(tabId)
                    activeTabs.delete(tabId)
                }

                if (requestInfo.fromWebSocket) {
                    chrome.runtime.sendMessage({
                        action: 'fetch_response',
                        id: requestId,
                        payload: {
                            ...message.response,
                            cookies: relevantCookies
                        }
                    })
                }

                pendingRequests.delete(requestId)
            });
        } else {
            if (tabId && activeTabs.has(tabId)) {
                chrome.tabs.remove(tabId)
                activeTabs.delete(tabId)
            }

            if (requestInfo.fromWebSocket) {
                chrome.runtime.sendMessage({
                    action: 'fetch_response',
                    id: requestId,
                    payload: message.response
                })
            }

            pendingRequests.delete(requestId)
        }
    } else if (message.action === 'ws_fetch_error') {
        if (tabId && activeTabs.has(tabId)) {
            chrome.tabs.remove(tabId)
            activeTabs.delete(tabId)
        }

        if (requestInfo.fromWebSocket) {
            chrome.runtime.sendMessage({
                action: 'fetch_response',
                id: requestId,
                error: message.error
            });
        }
    } else if (message.action === "ws_connection_status") {
        wsConnected = message.connected
    }

    return true
})