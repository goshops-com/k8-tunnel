#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const { program } = require('commander');
const packageJson = require('./package.json');

class NgrokLikeClient {
    constructor(serverAddress, subdomain, localPort) {
        this.serverAddress = serverAddress;
        this.subdomain = subdomain;
        this.localPort = localPort;
        this.ws = null;
    }

    start() {
        this.ws = new WebSocket(`ws://${this.serverAddress}`);

        this.ws.on('open', () => {
            console.log('Connected to server');
            this.register();
        });

        this.ws.on('close', () => {
            console.log('Disconnected from server');
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }

    register() {
        const message = JSON.stringify({
            type: 'register',
            subdomain: this.subdomain,
            target: `http://localhost:${this.localPort}`,
        });
        this.ws.send(message);
        console.log(`Registered with server: ${this.subdomain} -> localhost:${this.localPort}`);
    }

    stop() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

program
    .version(packageJson.version)
    .description('Ngrok-like client for forwarding local ports')
    .requiredOption('-p, --port <number>', 'Local port to forward')
    .requiredOption('-n, --name <string>', 'Subdomain name for the tunnel')
    .option('-s, --server <string>', 'Server address', 'localhost:3000')
    .parse(process.argv);

const options = program.opts();

const client = new NgrokLikeClient(options.server, options.name, options.port);
client.start();

// Start a simple HTTP server for testing
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Hello from the local server on port ${options.port}!`);
}).listen(options.port, () => {
    console.log(`Local server running on port ${options.port}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down client...');
    client.stop();
    process.exit(0);
});