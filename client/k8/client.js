const k8s = require('@kubernetes/client-node');
const WebSocket = require('ws');
const http = require('http');
const zlib = require('zlib');
const { promisify } = require('util');

class K8sTunnelClient {
    constructor(serverAddress, namespace = 'default') {
        this.serverAddress = serverAddress;
        this.namespace = namespace;
        this.kc = new k8s.KubeConfig();
        this.kc.loadFromDefault();
        this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
        this.watch = new k8s.Watch(this.kc);
        this.ws = null;
        this.registeredServices = new Map();
        console.log(`K8sTunnelClient initialized with server: ${serverAddress}, namespace: ${namespace}`);
    }

    async start() {
        console.log('Starting K8sTunnelClient');
        await this.connectToServer();
        this.watchServices();
    }

    connectToServer() {
        return new Promise((resolve, reject) => {
            console.log(`Connecting to server: ${this.serverAddress}`);
            this.ws = new WebSocket(`ws://${this.serverAddress}`);

            this.ws.on('open', () => {
                console.log('Connected to tunneling server');
                this.registerExistingServices();
                resolve();
            });

            this.ws.on('message', (data) => {
                const message = JSON.parse(data);
                if (message.type === 'request') {
                    this.handleRequest(message.data);
                }
            });

            this.ws.on('close', () => {
                console.log('Disconnected from tunneling server, attempting to reconnect...');
                setTimeout(() => this.connectToServer(), 5000);
            });

            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            });
        });
    }

    async registerExistingServices() {
        console.log('Registering existing services');
        try {
            const response = await this.k8sApi.listNamespacedService(this.namespace);
            response.body.items.forEach(service => this.registerService(service));
        } catch (error) {
            console.error('Error listing existing services:', error);
        }
    }

    watchServices() {
        console.log('Starting to watch services');
        this.watch.watch(
            `/api/v1/namespaces/${this.namespace}/services`,
            {},
            (type, apiObj) => {
                switch (type) {
                    case 'ADDED':
                    case 'MODIFIED':
                        this.registerService(apiObj);
                        break;
                    case 'DELETED':
                        this.unregisterService(apiObj);
                        break;
                }
            },
            (error) => {
                console.error('Error watching services:', error);
                setTimeout(() => this.watchServices(), 5000);
            }
        );
    }

    registerService(service) {
        const subdomain = `${service.metadata.name}-${service.metadata.namespace}`;
        const port = service.spec.ports[0].port;
        const clusterIP = service.spec.clusterIP;

        console.log(`Registering service: ${subdomain} -> ${clusterIP}:${port}`);

        if (this.ws.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'register',
                subdomain: subdomain,
                target: `http://${clusterIP}:${port}`
            });
            console.log(`Sending registration message: ${message}`);
            this.ws.send(message);
            this.registeredServices.set(subdomain, { clusterIP, port });
            console.log(`Registered service: ${subdomain} -> ${clusterIP}:${port}`);
        } else {
            console.log(`WebSocket not open. Queued registration for ${subdomain}`);
        }
    }

    unregisterService(service) {
        const subdomain = `${service.metadata.name}-${service.metadata.namespace}`;
        console.log(`Unregistering service: ${subdomain}`);
        if (this.registeredServices.has(subdomain)) {
            if (this.ws.readyState === WebSocket.OPEN) {
                const message = JSON.stringify({
                    type: 'unregister',
                    subdomain: subdomain
                });
                this.ws.send(message);
                this.registeredServices.delete(subdomain);
                console.log(`Unregistered service: ${subdomain}`);
            } else {
                console.log(`WebSocket not open. Queued unregistration for ${subdomain}`);
            }
        }
    }

    handleRequest(requestData) {
        // console.log('-------- New Request --------');
        // console.log(`Received request: ${requestData.method} ${requestData.path}`);
        // console.log(`Headers: ${JSON.stringify(requestData.headers, null, 2)}`);

        const subdomain = requestData.headers.host.split('.')[0];
        // console.log(`Extracted subdomain: ${subdomain}`);

        // console.log(`Registered services: ${Array.from(this.registeredServices.keys()).join(', ')}`);

        const serviceInfo = this.registeredServices.get(subdomain);

        if (!serviceInfo) {
            console.error(`No registered service found for subdomain: ${subdomain}`);
            this.sendErrorResponse('Service not found', 404);
            return;
        }

        // console.log(`Found service info: ${JSON.stringify(serviceInfo)}`);

        const options = {
            hostname: serviceInfo.clusterIP,
            port: serviceInfo.port,
            path: requestData.path,
            method: requestData.method,
            headers: requestData.headers
        };

        // console.log(`Forwarding request to: ${options.hostname}:${options.port}${options.path}`);

        const req = http.request(options, async (res) => {
            // console.log(`Received response from service with status code: ${res.statusCode}`);

            const headers = { ...res.headers };
            let wasCompressed = false;

            if (headers['content-encoding'] === 'br' || headers['content-encoding'] === 'gzip') {
                wasCompressed = true;
                delete headers['content-encoding'];
            }

            // Send response start
            this.ws.send(JSON.stringify({
                type: 'response_start',
                statusCode: res.statusCode,
                headers: headers,
                wasCompressed: wasCompressed
            }));

            let responseBody = Buffer.from([]);

            res.on('data', async (chunk) => {
                responseBody = Buffer.concat([responseBody, chunk]);

                if (responseBody.length > 65536) { // 64KB threshold
                    await this.decompressAndSend(responseBody, res.headers['content-encoding']);
                    responseBody = Buffer.from([]);
                }
            });

            res.on('end', async () => {
                // console.log('Response received completely');

                if (responseBody.length > 0) {
                    await this.decompressAndSend(responseBody, res.headers['content-encoding']);
                }

                // Send response end
                this.ws.send(JSON.stringify({
                    type: 'response_end',
                    headers: headers,
                    wasCompressed: wasCompressed
                }));
            });
        });

        req.on('error', (error) => {
            // console.error('Error forwarding request:', error);
            this.sendErrorResponse(`Error forwarding request to service: ${error.message}`, 502);
        });

        if (requestData.body) {
            // console.log('Request has body, writing to forwarded request');
            req.write(requestData.body);
        }

        req.end();
    }

    async decompressAndSend(data, encoding) {
        let decompressedData;
        let wasDecompressed = false;
        try {
            if (encoding === 'br') {
                const brotliDecompress = promisify(zlib.brotliDecompress);
                decompressedData = await brotliDecompress(data);
                // console.log('Brotli decompression successful');
                wasDecompressed = true;
            } else if (encoding === 'gzip') {
                const gunzip = promisify(zlib.gunzip);
                decompressedData = await gunzip(data);
                // console.log('Gzip decompression successful');
                wasDecompressed = true;
            } else {
                decompressedData = data;
            }
        } catch (error) {
            console.error(`Error decompressing data (${encoding}):`, error);
            decompressedData = data; // Send original data if decompression fails
        }

        this.ws.send(JSON.stringify({
            type: 'response_chunk',
            data: decompressedData.toString('base64'),
            wasDecompressed: wasDecompressed
        }));
    }


    sendErrorResponse(message, statusCode) {
        console.log(`Sending error response: ${statusCode} ${message}`);
        const response = {
            statusCode: statusCode,
            headers: { 'Content-Type': 'text/plain' },
            body: message,
        };
        this.ws.send(JSON.stringify(response));
    }
}

// Usage
const serverAddress = process.env.TUNNEL_SERVER_ADDRESS || 'localhost:3000';
const namespace = process.env.KUBERNETES_NAMESPACE || 'default';

const client = new K8sTunnelClient(serverAddress, namespace);
client.start().catch(error => {
    console.error('Failed to start client:', error);
    process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down client...');
    if (client.ws) {
        client.ws.close();
    }
    process.exit(0);
});

console.log('K8sTunnelClient script started');