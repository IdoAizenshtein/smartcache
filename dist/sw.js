/** @constant {string} CACHE_NAME - Name of the cache storage */
const CACHE_NAME = 'smart-cache-v1';

/** @constant {string} DB_NAME - Name of the IndexedDB database */
const DB_NAME = 'smart-cache-db';

/** @constant {string} STORE_NAME - Name of the object store in IndexedDB */
const STORE_NAME = 'offline-requests';

/** @constant {number} DB_VERSION - Version of the IndexedDB schema */
const DB_VERSION = 2;

/** @constant {number} MAX_RETRIES - Maximum retry attempts for failed requests */
const MAX_RETRIES = 5;

/** @constant {number} MAX_AGE - Maximum age (in ms) to keep a request: 7 days */
const MAX_AGE = 1000 * 60 * 60 * 24 * 7;

// --- IndexedDB Helpers ---

/**
 * Opens the IndexedDB database or creates it if it doesn't exist.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

/**
 * Saves a failed request to IndexedDB for later retry.
 * @param {Object} requestData - Request metadata (method, body, headers, etc.)
 * @returns {Promise<void>}
 */
function saveRequest(requestData) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.add(requestData);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    });
}

/**
 * Retrieves all offline-saved requests from IndexedDB.
 * @returns {Promise<Array>}
 */
function getAllRequests() {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    });
}

/**
 * Deletes a request by its ID from IndexedDB.
 * @param {number} id - Request ID
 * @returns {Promise<void>}
 */
function deleteRequest(id) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    });
}

/**
 * Updates retry count for a request in IndexedDB.
 * @param {number} id - Request ID
 * @param {number} retryCount - New retry count
 * @returns {Promise<void>}
 */
function updateRequestRetryCount(id, retryCount) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) {
                    data.retryCount = retryCount;
                    store.put(data).onsuccess = () => resolve();
                } else {
                    resolve();
                }
            };
            getReq.onerror = () => reject(getReq.error);
        });
    });
}

// --- Cache Helpers ---

/**
 * Caches a cloned response for a given request.
 * @param {Request} request
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function cachePut(request, response) {
    const cache = await caches.open(CACHE_NAME);
    return cache.put(request, response.clone());
}

/**
 * Attempts to retrieve a cached response for a given request.
 * @param {Request} request
 * @returns {Promise<Response|null>}
 */
async function cacheMatch(request) {
    const cache = await caches.open(CACHE_NAME);
    return cache.match(request);
}

// --- Request/Body Helpers ---

/**
 * Clones and reads the body of a request (as text).
 * @param {Request} request
 * @returns {Promise<string>}
 */
function cloneRequestBody(request) {
    return request.clone().text();
}

/**
 * Serializes headers into a plain object.
 * @param {Headers} headers
 * @returns {Object}
 */
function serializeHeaders(headers) {
    const serialized = {};
    for (const [key, value] of headers.entries()) {
        serialized[key] = value;
    }
    return serialized;
}

self.addEventListener('install', event => {
    console.log('SW installed')
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('SW activated');
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(
                names.map(name => {
                    if (name !== CACHE_NAME) return caches.delete(name);
                })
            )
        ).then(() => self.clients.claim())
    );
});

// --- Fetch Event ---

/**
 * Main fetch event handler: supports caching and offline request queuing.
 */
self.addEventListener('fetch', event => {
    const request = event.request;
    const method = request.method;
    console.log('SW fetch for:', event.request.url);
    // Cache-first strategy for GET/HEAD
    if (method === 'GET' || method === 'HEAD') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    cachePut(request, response.clone());
                    sendMessageToClients({ type: 'OFFLINE_REQUEST_SYNCED', url: request.url, method: request.method });
                    return response;
                })
                .catch(async () => {
                    const cached = await cacheMatch(request);
                    if (cached) {
                        sendMessageToClients({ type: 'OFFLINE_USAGE' });
                        return cached;
                    }
                    return new Response('Offline and no cached data', {
                        status: 503,
                        statusText: 'Service Unavailable',
                    });
                })
        );
        return;
    }

    // Offline queueing for other HTTP methods
    if (method !== 'GET' && method !== 'HEAD') {
        event.respondWith(
            fetch(request.clone())
                .then(response => response)
                .catch(async () => {
                    try {
                        const bodyText = await cloneRequestBody(request);
                        const headers = serializeHeaders(request.headers);
                        const requestData = {
                            url: request.url,
                            method: request.method,
                            headers,
                            body: bodyText,
                            contentType: request.headers.get('Content-Type') || '',
                            timestamp: Date.now(),
                            retryCount: 0,
                        };

                        await saveRequest(requestData);
                        sendMessageToClients({ type: 'OFFLINE_REQUEST_SAVED', url: request.url, method: request.method });

                        return new Response(JSON.stringify({
                            offline: true,
                            message: 'Request saved for later sync',
                        }), {
                            headers: { 'Content-Type': 'application/json' },
                            status: 202,
                        });
                    } catch (err) {
                        return new Response(JSON.stringify({ error: 'Failed to save request offline' }), {
                            headers: { 'Content-Type': 'application/json' },
                            status: 500,
                        });
                    }
                })
        );
        return;
    }
});

// --- Message Event ---

/**
 * Listens for messages from the client (e.g., trigger manual sync).
 */
self.addEventListener('message', event => {
    if (!event.data) return;
    console.log('SW got message:', event.data);

    if (event.data.type === 'SYNC_OFFLINE_REQUESTS') {
        syncOfflineRequests();
    }
});

// --- Offline Request Sync ---

/**
 * Attempts to resend all offline requests saved in IndexedDB.
 */
async function syncStoredPosts() {
    const requests = await getAllRequests();
    const now = Date.now();

    for (const req of requests) {
        if (now - req.timestamp > MAX_AGE) {
            await deleteRequest(req.id);
            continue;
        }

        if ((req.retryCount || 0) >= MAX_RETRIES) {
            await deleteRequest(req.id);
            continue;
        }

        try {
            const headers = new Headers(req.headers || {});
            if (req.contentType) {
                headers.set('Content-Type', req.contentType);
            }

            const response = await fetch(req.url, {
                method: req.method,
                headers,
                body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
            });

            if (response.ok) {
                await deleteRequest(req.id);
                sendMessageToClients({ type: 'OFFLINE_REQUEST_SYNCED', url: req.url, method: req.method });
            } else {
                await updateRequestRetryCount(req.id, (req.retryCount || 0) + 1);
            }
        } catch (err) {
            await updateRequestRetryCount(req.id, (req.retryCount || 0) + 1);
            console.warn('[SmartCache SW] Failed to sync request:', req, err);
        }
    }
}

/**
 * Attempts to resend all offline requests and update cached GET/HEAD responses.
 *
 * First, invokes `syncStoredPosts()` to resend any POST requests stored in IndexedDB.
 * Then, opens the specified cache (`CACHE_NAME`) and retrieves all cached `GET` or `HEAD` requests.
 * For each cached request:
 *   1. Tries to fetch the latest response from the network.
 *   2. If the network fetch succeeds, replaces the cached entry via `cachePut(...)` and notifies all clients
 *      with `{ type: 'OFFLINE_REQUEST_SYNCED', url, method }`.
 *   3. If the network fetch fails (e.g., still offline), attempts to serve the existing cached response;
 *      if one exists, notifies clients with `{ type: 'OFFLINE_USAGE' }`.
 *
 * Any errors opening or iterating over the cache are caught and logged to the console.
 */
async function syncOfflineRequests() {
    await syncStoredPosts();

    try {
        const cache = await caches.open(CACHE_NAME);
        const requests = await cache.keys();
        const getRequests = requests.filter(req => req.method === 'GET' || req.method === 'HEAD');

        await Promise.all(
            getRequests.map(async request => {
                try {
                    const response = await fetch(request);
                    await cachePut(request, response.clone());
                    sendMessageToClients({ type: 'OFFLINE_REQUEST_SYNCED', url: request.url, method: request.method });
                    console.log('Cache updated for:', request.url);
                } catch (err) {
                    const cached = await cacheMatch(request);
                    if (cached) {
                        sendMessageToClients({ type: 'OFFLINE_USAGE' });
                    }
                }
            })
        );
    } catch (err) {
        console.error('Error syncing GETs from Cache:', err);
    }
}

// --- Client Communication ---

/**
 * Sends a message to all connected clients (tabs/pages).
 * @param {Object} msg - Message to send
 */
function sendMessageToClients(msg) {
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage(msg);
        });
    });
}