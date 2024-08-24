const http = require('http');
const httpProxy = require('http-proxy');
const url = require('url');
const fs = require('fs').promises;
const path = require('path');

const proxy = httpProxy.createProxyServer();
const clients = new Map();
const storageFile = path.join(__dirname, 'client_storage.json');

async function loadClients() {
    try {
        const data = await fs.readFile(storageFile, 'utf8');
        const storedClients = JSON.parse(data);
        storedClients.forEach(([subdomain, target]) => clients.set(subdomain, target));
        console.log('Loaded clients from storage');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Error loading clients:', error);
        }
    }
}

async function saveClients() {
    try {
        const data = JSON.stringify(Array.from(clients));
        await fs.writeFile(storageFile, data, 'utf8');
        console.log('Saved clients to storage');
    } catch (error) {
        console.error('Error saving clients:', error);
    }
}

const server = http.createServer((req, res) => {
    const hostname = req.headers.host;
    const subdomain = hostname.split('.')[0];

    if (clients.has(subdomain)) {
        const target = clients.get(subdomain);
        proxy.web(req, res, { target });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Subdomain not found');
    }
});

const registerClient = async (subdomain, target) => {
    clients.set(subdomain, target);
    console.log(`Registered client: ${subdomain} -> ${target}`);
    await saveClients();
};

const unregisterClient = async (subdomain) => {
    clients.delete(subdomain);
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
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let clientSubdomain = null;

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.type === 'register') {
            clientSubdomain = data.subdomain;
            await registerClient(data.subdomain, data.target);
        }
    });

    ws.on('close', async () => {
        if (clientSubdomain) {
            await unregisterClient(clientSubdomain);
        }
    });
});