#!/usr/bin/env node

const WebSocket = require('ws');
const http = require('http');
const { program } = require('commander');

class WebSocketTunnelClient {
    constructor(serverAddress, subdomain, localPort) {
        this.serverAddress = serverAddress;
        this.subdomain = subdomain;
        this.localPort = localPort;
        this.ws = null;
    }

    start() {
        console.log(`Connecting to server: ${this.serverAddress}`);
        this.connect();
    }

    connect() {
        this.ws = new WebSocket(`ws://${this.serverAddress}`);

        this.ws.on('open', () => {
            console.log('Connected to server');
            this.register();
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'request') {
                this.handleRequest(message.data);
            }
        });

        this.ws.on('close', () => {
            console.log('Disconnected from server, attempting to reconnect...');
            setTimeout(() => this.connect(), 5000);
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
        console.log(`Sent registration: ${this.subdomain} -> localhost:${this.localPort}`);
    }

    handleRequest(requestData) {
        const options = {
            hostname: 'localhost',
            port: this.localPort,
            path: requestData.path,
            method: requestData.method,
            headers: requestData.headers,
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                const response = {
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: body,
                };
                this.ws.send(JSON.stringify(response));
            });
        });

        req.on('error', (error) => {
            console.error('Error forwarding request:', error);
            const response = {
                statusCode: 502,
                headers: { 'Content-Type': 'text/plain' },
                body: 'Error forwarding request to local server',
            };
            this.ws.send(JSON.stringify(response));
        });

        req.end();
    }

    stop() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

program
    .version('1.0.0')
    .description('WebSocket-based tunnel client for forwarding local ports')
    .requiredOption('-p, --port <number>', 'Local port to forward')
    .requiredOption('-n, --name <string>', 'Subdomain name for the tunnel')
    .option('-s, --server <string>', 'Server address', 'dev.goshops.com:3000')
    .parse(process.argv);

const options = program.opts();

const client = new WebSocketTunnelClient(options.server, options.name, options.port);
client.start();

console.log(`Forwarding requests to localhost:${options.port}`);
console.log(`Your URL will be: http://${options.name}.${options.server.split(':')[0]}:${options.server.split(':')[1]}`);
console.log('Press Ctrl+C to stop the client');

process.on('SIGINT', () => {
    console.log('Shutting down client...');
    client.stop();
    process.exit(0);
});