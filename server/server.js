const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const clients = new Map();
const registrationQueue = new Map();
const storageFile = path.join(__dirname, 'client_storage.json');

async function loadClients() {
    try {
        const data = await fs.readFile(storageFile, 'utf8');
        const storedClients = JSON.parse(data);
        storedClients.forEach(([subdomain, target]) => {
            clients.set(subdomain, { target });
            registrationQueue.set(subdomain, target);
        });
        console.log('Loaded clients from storage');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Error loading clients:', error);
        }
    }
}

async function saveClients() {
    try {
        const data = JSON.stringify(Array.from(registrationQueue));
        await fs.writeFile(storageFile, data, 'utf8');
        console.log('Saved clients to storage');
    } catch (error) {
        console.error('Error saving clients:', error);
    }
}

const server = http.createServer((req, res) => {
    // console.log('-------- New Request --------');
    // console.log(`Received request: ${req.method} ${req.url}`);
    // console.log(`Headers: ${JSON.stringify(req.headers, null, 2)}`);

    const parsedUrl = url.parse(req.url, true);
    const hostname = req.headers.host;
    // console.log(`Hostname: ${hostname}`);

    const subdomain = hostname.split('.')[0];
    // console.log(`Extracted subdomain: ${subdomain}`);

    // console.log(`Registered clients: ${Array.from(clients.keys()).join(', ')}`);
    // console.log(`Registration queue: ${Array.from(registrationQueue.keys()).join(', ')}`);

    if (parsedUrl.pathname === '/_map') {
        console.log('Handling /_map request');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.from(registrationQueue), null, 2));
        return;
    }

    if (clients.has(subdomain)) {
        // console.log(`Found client for subdomain: ${subdomain}`);
        const clientInfo = clients.get(subdomain);
        if (clientInfo.ws && clientInfo.ws.readyState === WebSocket.OPEN) {
            // console.log('WebSocket connection is open, forwarding request');
            let body = [];
            req.on('data', (chunk) => {
                body.push(chunk);
            }).on('end', () => {
                body = Buffer.concat(body).toString();
                const requestData = {
                    method: req.method,
                    path: req.url,
                    headers: req.headers,
                    body: body
                };
                // console.log(`Sending request to client: ${JSON.stringify(requestData)}`);
                clientInfo.ws.send(JSON.stringify({ type: 'request', data: requestData }));
            });

            let responseBuffer = Buffer.from([]);
            clientInfo.ws.on('message', (message) => {
                // console.log('Received response chunk from client');
                const chunk = JSON.parse(message);
                if (chunk.type === 'response_start') {
                    // console.log(`Starting response with status: ${chunk.statusCode}`);
                    res.writeHead(chunk.statusCode, chunk.headers);
                } else if (chunk.type === 'response_chunk') {
                    // console.log(`Received response chunk of size: ${chunk.data.length}`);
                    responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk.data, 'base64')]);
                } else if (chunk.type === 'response_end') {
                    // console.log('Response ended, processing final data');
                    if (chunk.headers['content-encoding'] === 'br') {
                        zlib.brotliDecompress(responseBuffer, (err, decoded) => {
                            if (err) {
                                console.error('Error decompressing brotli data:', err);
                                res.end();
                            } else {
                                res.end(decoded);
                            }
                        });
                    } else {
                        res.end(responseBuffer);
                    }
                }
            });
        } else {
            console.log('WebSocket connection is not open');
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Client not connected');
        }
    } else {
        console.log(`No client found for subdomain: ${subdomain}`);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Subdomain not found');
    }
});

const registerClient = async (subdomain, target, ws) => {
    clients.set(subdomain, { target, ws });
    registrationQueue.set(subdomain, target);
    console.log(`Registered client: ${subdomain} -> ${target}`);
    await saveClients();
};

const unregisterClient = async (subdomain) => {
    clients.delete(subdomain);
    registrationQueue.delete(subdomain);
    console.log(`Unregistered client: ${subdomain}`);
    await saveClients();
};

// Load clients from storage when starting the server
loadClients().then(() => {
    server.listen(3000, '0.0.0.0', () => {
        console.log('Server running on port 3000');
    });
});

// WebSocket server for client registration
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let clientSubdomain = null;

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.type === 'register') {
            clientSubdomain = data.subdomain;
            await registerClient(data.subdomain, data.target, ws);
        }
    });

    ws.on('close', async () => {
        if (clientSubdomain) {
            await unregisterClient(clientSubdomain);
        }
    });
});

console.log('Server started');