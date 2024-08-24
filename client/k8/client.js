const k8s = require('@kubernetes/client-node');
const WebSocket = require('ws');

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
    }

    async start() {
        this.connectToServer();
        this.watchServices();
    }

    connectToServer() {
        this.ws = new WebSocket(`ws://${this.serverAddress}`);

        this.ws.on('open', () => {
            console.log('Connected to tunneling server');
            this.registerExistingServices();
        });

        this.ws.on('close', () => {
            console.log('Disconnected from tunneling server, attempting to reconnect...');
            setTimeout(() => this.connectToServer(), 5000);
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    }

    async registerExistingServices() {
        try {
            const response = await this.k8sApi.listNamespacedService(this.namespace);
            response.body.items.forEach(service => this.registerService(service));
        } catch (error) {
            console.error('Error listing existing services:', error);
        }
    }

    watchServices() {
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
        const port = service.spec.ports[0].port; // Assuming the first port
        const clusterIP = service.spec.clusterIP;

        if (this.ws.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'register',
                subdomain: subdomain,
                target: `http://${clusterIP}:${port}`
            });
            this.ws.send(message);
            this.registeredServices.set(subdomain, { clusterIP, port });
            console.log(`Registered service: ${subdomain} -> ${clusterIP}:${port}`);
        } else {
            console.log(`Server not connected. Queued registration for ${subdomain}`);
        }
    }

    unregisterService(service) {
        const subdomain = `${service.metadata.name}-${service.metadata.namespace}`;
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
                console.log(`Server not connected. Queued unregistration for ${subdomain}`);
            }
        }
    }
}

// Usage
const serverAddress = process.env.TUNNEL_SERVER_ADDRESS || 'localhost:3000';
const namespace = process.env.KUBERNETES_NAMESPACE || 'default';

const client = new K8sTunnelClient(serverAddress, namespace);
client.start();